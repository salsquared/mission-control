/**
 * M8.6.1 (story S7.13 resume-gen half) — Synthesize fresh bullet candidates
 * from per-entity scratchpads + posting keywords at resume-generation time.
 *
 * Distinct from:
 *   - `bullet-assist-fill` (M7.6) → per-entity, no posting context, persists
 *     to the profile on Accept. Used from the Profile dash to bootstrap an
 *     empty entry.
 *   - `bullet-tags-from-posting` (M8.5) → bulk pass at resume-gen time, tags
 *     existing profile bullets with posting keywords they already evidence.
 *   - `bullet-tags-from-profile` (M7.7) → per-bullet manual tag refresh.
 *
 * This callsite runs DURING resume-generation, AFTER selectBullets +
 * autoTagBullets but BEFORE rewriteBullets, for each entity whose:
 *   1. structured bullets under-cover the posting keywords (gap exists)
 *   2. AND scratchpad is non-empty
 *   3. AND scratchpad mentions at least one of the uncovered keywords
 *      (caller-level heuristic — short-circuits zero-yield calls)
 *
 * Batched since 2026-05-28 (docs/llm-calls.html §6 Tier 2b): every gated
 * entity is sent in ONE LLM call as a delimited, numbered block, and the
 * model returns one output object per entry, positionally aligned. This
 * replaced the former one-call-per-entity loop — it pays the ~250-token
 * system prompt ONCE instead of N times and takes one rate-limit slot instead
 * of N. Latency was already 1× (the old loop ran in parallel), so the win is
 * purely tokens + call count.
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
 *   4. Entry isolation — each entry is rendered as its own delimited block and
 *      the system prompt forbids letting one entry's notes inform another's
 *      bullets. The firewall is structural (delimited blocks + positional
 *      output) plus instructional (system rule 8).
 *
 * Best-effort posture in the route: if this caller throws, the route logs a
 * warning and continues with whatever the select+autoTag pass produced. One
 * batched call is all-or-nothing for the synthesis step (a throw drops every
 * entity's candidates), but the resume still generates from select+rewrite.
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

/**
 * One entity in a synthesis batch. `postingKeywords` is shared across the
 * batch (it lives on {@link SynthesizeBatchInput}); everything here is the
 * entity's own isolated grounding.
 */
export interface SynthesizeEntityInput {
    entityKind: ScratchpadSynthEntityKind;
    entityId: string;
    entitySpine: ScratchpadSynthEntitySpine;
    /** Non-empty trimmed scratchpad. Caller short-circuits when empty. */
    scratchpad: string;
    /** Keywords NOT yet covered by THIS entity's existing bullets (skills-gap signal). */
    uncoveredKeywords: readonly string[];
    /** Cap on synthesized bullets for this entity. Falls back to the batch
     *  default, then {@link DEFAULT_MAX_BULLETS}. */
    maxBullets?: number;
}

export interface SynthesizeBatchInput {
    /** One or more entities, each synthesized in isolation within ONE call. */
    entities: readonly SynthesizeEntityInput[];
    /** Full posting keyword list — shared across all entities. */
    postingKeywords: readonly string[];
    /** Default per-entity bullet cap when an entity doesn't set its own. */
    maxBullets?: number;
}

export interface SynthesizeBatchResult {
    /** Positional, aligned to `input.entities` (carries entityId for mapping). */
    perEntity: Array<{ entityId: string; bullets: Bullet[] }>;
    durationMs: number;
}

const DEFAULT_MAX_BULLETS = 3;
const SYNTH_TEMPERATURE = 0.4;
// Output budget scales with the entity count: ~1.5k tokens per entity (≤3
// bullets × text+tags+JSON overhead) plus a fixed wrapper, capped so a
// runaway response can't blow the budget. N=1 → 2k, N=4 → ~6.6k.
const SYNTH_TOKENS_PER_ENTITY = 1_536;
const SYNTH_TOKENS_BASE = 512;
const SYNTH_MAX_OUTPUT_TOKENS_CAP = 8_192;
// Scratchpad prompt cap — re-uses the bullet-assist budget. The scratchpad
// column itself is up to 8 KB on disk; we trim before sending so the prompt
// stays bounded. Front-loaded trim matches `renderScratchpad`'s behavior in
// bullet-assist — the user typically leads with the most important context.
const SCRATCHPAD_PROMPT_CAP_BYTES = 2_048;

// Strict per-entry shape from the model: `entries` aligned by index to the
// input entities, each carrying that entry's synthesized bullets. We slice
// each entry down to its maxBullets after.
const BatchResponseSchema = z.object({
    entries: z.array(z.object({
        bullets: z.array(z.object({
            text: z.string().min(1).max(500),
            tags: z.array(z.string().min(1).max(60)).max(7),
        })).max(10),
    })).max(50),
});

// ============================================================================
// Pure helpers — spine + keyword renderers + scratchpad trim + entries block
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

/**
 * Render every entity as a delimited, numbered block for the batch prompt.
 * Each block carries ONLY that entity's spine + scratchpad + uncovered
 * keywords — the structural half of the cross-entity firewall (the other
 * half is system rule 8). Entry numbering is 1-based and load-bearing: the
 * model is told to return one output object per entry, in this order.
 */
export function renderEntitiesBlock(
    entities: readonly SynthesizeEntityInput[],
    defaultMaxBullets: number,
): string {
    return entities.map((e, i) => {
        const max = e.maxBullets ?? defaultMaxBullets;
        return [
            `### Entry ${i + 1} — up to ${max} bullet${max === 1 ? '' : 's'}`,
            `Spine: ${renderSynthSpine(e.entityKind, e.entitySpine)}`,
            `Scratchpad (this entry's own voice — match its cadence):`,
            trimScratchpadForPrompt(e.scratchpad),
            `Uncovered posting keywords for this entry (high-value targets):`,
            renderUncoveredKeywords(e.uncoveredKeywords),
        ].join('\n');
    }).join('\n\n');
}

// ============================================================================
// Caller
// ============================================================================

/**
 * Synthesize fresh bullet candidates for one or more entities in a SINGLE
 * LLM call. Each entity is rendered as an isolated, numbered block; the model
 * returns `entries[]` positionally aligned to `input.entities`. Returns up to
 * each entity's `maxBullets` Bullets in the canonical shape (server-filled ids
 * + defaults). An entity yields `bullets: []` when the model decides nothing
 * defensible can be synthesized — empty is the SAFE default the prompt invites.
 *
 * Count drift (model returns too few/many entries) is tolerated: alignment is
 * strictly by index, missing entries yield no bullets, extras are ignored — it
 * never throws on a mismatch.
 *
 * THROWS on Gemini errors. The caller (resume-gen route) wraps in try/catch so
 * a synthesis failure doesn't block the user's resume.
 */
export async function synthesizeBulletsForEntities(input: SynthesizeBatchInput): Promise<SynthesizeBatchResult> {
    const start = Date.now();

    if (input.entities.length === 0) {
        return { perEntity: [], durationMs: 0 };
    }

    const defaultMax = input.maxBullets ?? DEFAULT_MAX_BULLETS;

    const prompt = await loadPrompt('scratchpad-synth', {
        postingKeywords: renderAllPostingKeywords(input.postingKeywords),
        entriesBlock: renderEntitiesBlock(input.entities, defaultMax),
    });

    const maxOutputTokens = Math.min(
        SYNTH_MAX_OUTPUT_TOKENS_CAP,
        SYNTH_TOKENS_BASE + input.entities.length * SYNTH_TOKENS_PER_ENTITY,
    );

    const response = await chatJSON({
        name: 'scratchpad-synth',
        system: prompt.system,
        user: prompt.user,
        schema: BatchResponseSchema,
        model: prompt.model ?? MODEL_LITE,
        maxOutputTokens: prompt.maxOutputTokens ?? maxOutputTokens,
        temperature: prompt.temperature ?? SYNTH_TEMPERATURE,
    });

    if (response.entries.length !== input.entities.length) {
        console.warn(
            `[scratchpad-synth] batch returned ${response.entries.length} entries for ${input.entities.length} entities — aligning by index`,
        );
    }

    // Positional alignment: entries[i] ↔ entities[i]. Trim to maxBullets,
    // fill bullet defaults. Synthesized tags get marked as autoTags so the
    // existing UI badge (Sparkles + cyan border, from M8.5.6) renders if the
    // user later copies one into their profile.
    const perEntity = input.entities.map((e, i) => {
        const max = e.maxBullets ?? defaultMax;
        const raw = response.entries[i]?.bullets ?? [];
        const bullets: Bullet[] = raw.slice(0, max).map(b => ({
            id: newBulletId(),
            text: b.text,
            tags: b.tags,
            autoTags: b.tags,
            removedTags: [],
            pinnedTags: [],
            locked: false,
            excluded: false,
        }));
        return { entityId: e.entityId, bullets };
    });

    const durationMs = Date.now() - start;
    const total = perEntity.reduce((acc, p) => acc + p.bullets.length, 0);
    console.info(
        `[LLM] scratchpad-synth (batch) → ${total} bullets across ${input.entities.length} entities in ${durationMs}ms`,
    );

    return { perEntity, durationMs };
}
