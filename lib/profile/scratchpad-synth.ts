/**
 * M8.6.1 (story S7.13 resume-gen half) — Synthesize fresh bullet candidates
 * from a per-entity scratchpad + posting keywords at resume-generation time.
 *
 * Distinct from:
 *   - `bullet-assist-fill` (M7.6) → per-entity, no posting context, persists
 *     to the profile on Accept. Used from the Profile dash to bootstrap an
 *     empty entry.
 *   - `bullet-auto-tag` (M8.5) → bulk pass at resume-gen time, tags existing
 *     profile bullets with posting keywords they already evidence.
 *   - `bullet-tag-suggest` (M7.7) → per-bullet manual tag refresh.
 *
 * This callsite runs DURING resume-generation, AFTER selectBullets +
 * autoTagBullets but BEFORE rewriteBullets, for each entity whose:
 *   1. structured bullets under-cover the posting keywords (gap exists)
 *   2. AND scratchpad is non-empty
 *   3. AND scratchpad mentions at least one of the uncovered keywords
 *      (caller-level heuristic — short-circuits zero-yield calls)
 *
 * The synthesized bullets join the selection list as kind="scratchpad-synth"
 * rows. They flow through the existing rewrite step like any other selection
 * (rewrite is text-only post-M7.7.2, so tags pass through). Server-side they
 * are NOT persisted to the user's profile — they live only in the generated
 * resume's `GeneratedResume.selections` archive. The user can copy a winner
 * back into the profile manually if they want to keep it.
 *
 * Hard invariants enforced by the system prompt + this caller:
 *   1. No fabrication — the LLM only synthesizes bullets grounded in the
 *      scratchpad text + the posting + the entity spine. No invented metrics,
 *      no claims of technologies not in the scratchpad or posting.
 *   2. Voice preservation — the LLM is told to match the user's cadence from
 *      the scratchpad. Generic resume-speak is a failure mode.
 *   3. Posting-keyword verbatim use where natural — the LLM uses the
 *      posting's exact keyword strings where the scratchpad evidence
 *      supports them, so an ATS picks up the match.
 *
 * Best-effort posture in the route: if this caller throws, the route logs
 * a warning and continues with whatever the select+autoTag pass produced.
 * Mirrors `autoTagBullets`'s posture in M8.5.4 — synthesis is augmentation,
 * never a blocker.
 */

import { z } from 'zod';
import { chatJSON, MODEL_LITE } from '@/lib/ai/gemini';
import { loadPrompt } from '@/lib/ai/prompts';
import { newBulletId } from '@/lib/profile/bullets';
import type { Bullet } from '@/lib/profile/types';

// ============================================================================
// Types
// ============================================================================

export type ScratchpadSynthEntityKind = 'work-role' | 'project' | 'education';

export interface ScratchpadSynthEntitySpine {
    company?: string | null;
    title?: string | null;
    name?: string | null;
    institution?: string | null;
    degree?: string | null;
    field?: string | null;
    location?: string | null;
    startDate?: string | null;
    endDate?: string | null;
}

export interface SynthesizeBulletsInput {
    entityKind: ScratchpadSynthEntityKind;
    entityId: string;
    entitySpine: ScratchpadSynthEntitySpine;
    /** Non-empty trimmed scratchpad. Caller short-circuits when empty. */
    scratchpad: string;
    /** Full posting keyword list — used to weight + validate the synthesis. */
    postingKeywords: readonly string[];
    /** Keywords NOT yet covered by existing profile bullets (skills-gap signal). */
    uncoveredKeywords: readonly string[];
    /** Cap on synthesized bullets per entity. Default 3 — keeps the resume
     *  from filling with LLM output when the scratchpad is rambly. */
    maxBullets?: number;
}

export interface SynthesizeBulletsResult {
    bullets: Bullet[];
    durationMs: number;
}

const DEFAULT_MAX_BULLETS = 3;
const SYNTH_MAX_OUTPUT_TOKENS = 2_048;
const SYNTH_TEMPERATURE = 0.4;
// Scratchpad prompt cap — re-uses the bullet-assist budget. The scratchpad
// column itself is up to 8 KB on disk; we trim before sending so the prompt
// stays bounded. Front-loaded trim matches `renderScratchpad`'s behavior in
// bullet-assist — the user typically leads with the most important context.
const SCRATCHPAD_PROMPT_CAP_BYTES = 2_048;

// Strict per-bullet shape from the model. We slice down to maxBullets after.
const ResponseSchema = z.object({
    bullets: z.array(z.object({
        text: z.string().min(1).max(500),
        tags: z.array(z.string().min(1).max(60)).max(7),
    })).max(10),
});

// ============================================================================
// Pure helpers — spine + uncovered-keyword renderers + scratchpad trim
// ============================================================================

/**
 * Short 1-line context for the prompt. Kept compact so the model focuses
 * on the scratchpad + posting keywords rather than re-describing the entry.
 */
export function renderSynthSpine(
    kind: ScratchpadSynthEntityKind,
    spine: ScratchpadSynthEntitySpine,
): string {
    if (kind === 'work-role') {
        const role = spine.title?.trim() || '(untitled role)';
        const company = spine.company?.trim() || '(unknown company)';
        return `${role} at ${company}`;
    }
    if (kind === 'project') {
        return `Project: ${spine.name?.trim() || '(unnamed)'}`;
    }
    const degree = spine.degree?.trim() || 'Education';
    const inst = spine.institution?.trim() || '(unknown institution)';
    return `${degree} at ${inst}`;
}

export function renderUncoveredKeywords(uncovered: readonly string[]): string {
    if (uncovered.length === 0) return '  (none — but synthesize bullets that the posting would value anyway)';
    return uncovered.map(k => `  - ${k}`).join('\n');
}

export function renderAllPostingKeywords(all: readonly string[]): string {
    if (all.length === 0) return '  (none)';
    return all.map(k => `  - ${k}`).join('\n');
}

/**
 * Trim scratchpad to a byte budget for the prompt. Front-trim — drops the
 * trailing portion, since the user typically leads with the most important
 * context. (Matches `renderScratchpad` behavior in bullet-assist.)
 */
export function trimScratchpadForPrompt(scratchpad: string, cap: number = SCRATCHPAD_PROMPT_CAP_BYTES): string {
    const trimmed = scratchpad.trim();
    if (Buffer.byteLength(trimmed, 'utf8') <= cap) return trimmed;
    let candidate = trimmed;
    while (Buffer.byteLength(candidate, 'utf8') > cap - 16 && candidate.length > 0) {
        candidate = candidate.slice(0, -64);
    }
    return `${candidate}…(truncated)`;
}

// ============================================================================
// Caller
// ============================================================================

/**
 * Synthesize fresh bullet candidates for one entity from its scratchpad +
 * posting keywords. Returns up to `maxBullets` Bullets in the canonical
 * shape (server-filled ids + defaults). Returns `bullets: []` when the
 * model decides nothing defensible can be synthesized — empty is the
 * SAFE default and what the prompt explicitly invites.
 *
 * THROWS on Gemini errors. The caller (resume-gen route) wraps in try/catch
 * so synthesis failures don't block the user's resume.
 */
export async function synthesizeBulletsForEntity(input: SynthesizeBulletsInput): Promise<SynthesizeBulletsResult> {
    const start = Date.now();
    const maxBullets = input.maxBullets ?? DEFAULT_MAX_BULLETS;

    const prompt = await loadPrompt('scratchpad-synth', {
        spine: renderSynthSpine(input.entityKind, input.entitySpine),
        scratchpad: trimScratchpadForPrompt(input.scratchpad),
        postingKeywords: renderAllPostingKeywords(input.postingKeywords),
        uncoveredKeywords: renderUncoveredKeywords(input.uncoveredKeywords),
        maxBullets: String(maxBullets),
    });

    const response = await chatJSON({
        name: 'scratchpad-synth',
        system: prompt.system,
        user: prompt.user,
        schema: ResponseSchema,
        model: prompt.model ?? MODEL_LITE,
        maxOutputTokens: prompt.maxOutputTokens ?? SYNTH_MAX_OUTPUT_TOKENS,
        temperature: prompt.temperature ?? SYNTH_TEMPERATURE,
    });

    // Trim to maxBullets, fill bullet defaults. Synthesized tags get marked
    // as autoTags so the existing UI badge (Sparkles + cyan border, from
    // M8.5.6) renders if the user later copies one into their profile.
    const bullets: Bullet[] = response.bullets.slice(0, maxBullets).map(b => ({
        id: newBulletId(),
        text: b.text,
        tags: b.tags,
        autoTags: b.tags,
        removedTags: [],
        pinnedTags: [],
        locked: false,
        excluded: false,
    }));

    const durationMs = Date.now() - start;
    console.info(
        `[LLM] scratchpad-synth:${input.entityKind}:${input.entityId} → ${bullets.length} bullets in ${durationMs}ms (uncovered=${input.uncoveredKeywords.length})`,
    );

    return { bullets, durationMs };
}
