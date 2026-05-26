/**
 * M7.9.3 (story S7.14) — LLM-drafted one-sentence profile tagline.
 *
 * The user has two flows in the UI: type the tagline themselves, or click
 * the AI-draft Sparkles button on `PersonalInfoCard` and let the LLM
 * propose one. This caller handles the LLM side. Two modes, dispatched
 * automatically by whether the user's current `profile.tagline` is non-
 * empty:
 *
 *   - **Empty current tagline → 'draft' mode.** The LLM produces a
 *     one-sentence tagline grounded ONLY on the profile evidence (work
 *     roles, projects, education, summary, skills/hobbies/languages,
 *     per-entity scratchpads). Self-contained pitch the user can keep or
 *     edit. Fewer constraints — the LLM is starting from scratch.
 *
 *   - **Non-empty current tagline → 'enhance' mode.** The LLM takes the
 *     user's existing text as the starting intent and refines for fit +
 *     voice consistency with the rest of the profile. The user's angle is
 *     the floor — the rewrite preserves their framing, doesn't pivot to a
 *     different concept.
 *
 * Hard invariants (system prompt + caller post-filter):
 *   1. No fabrication — the LLM can't claim experience the profile
 *      doesn't already evidence.
 *   2. One sentence — server post-filter strips trailing newlines + adds a
 *      period if absent.
 *   3. ≤ 200 chars — schema enforces; server truncates defensively at
 *      cap if the LLM over-shoots.
 *   4. No first-person pronouns / possessives ("I" / "my" / "me") —
 *      enforced via prompt; not post-filter-able cheaply.
 *
 * Best-effort posture in the route: caller throws on AIError; the route
 * returns 502 and the UI surfaces "draft failed". The user's existing
 * tagline (if any) is unchanged either way — this caller does NOT
 * persist. The client persists via the existing profile PATCH on Accept.
 */

import { z } from 'zod';
import { chatJSON, MODEL_LITE } from '@/lib/ai/gemini';
import { loadPrompt } from '@/lib/ai/prompts';
import { findOrCreateProfile } from '@/lib/repositories/profile';

// ============================================================================
// Types
// ============================================================================

export type TaglineDraftMode = 'draft' | 'enhance';

export interface DraftTaglineInput {
    userId: string;
}

export interface DraftTaglineResult {
    tagline: string;
    mode: TaglineDraftMode;
    durationMs: number;
}

const TAGLINE_HARD_CAP = 200;
const SYNTH_MAX_OUTPUT_TOKENS = 256;
const SYNTH_TEMPERATURE = 0.4;
// Per-section byte caps for the compact profile summary that goes into
// the prompt. Keeps the budget bounded for a profile with many bullets +
// long scratchpads. Total budget aims at ≤ 4 KB before the rest of the
// template (system prompt, output schema, etc.) wraps it.
const SUMMARY_PER_ENTITY_CAP_BYTES = 600;

const ResponseSchema = z.object({
    tagline: z.string().min(1).max(500),
});

// ============================================================================
// Pure helpers — build the compact profile summary for the prompt
// ============================================================================

type HydratedProfile = Awaited<ReturnType<typeof findOrCreateProfile>>;

interface CompactSection {
    label: string;
    body: string;
}

function clip(s: string | null | undefined, cap: number): string {
    if (!s) return '';
    const trimmed = s.trim();
    if (trimmed.length === 0) return '';
    if (Buffer.byteLength(trimmed, 'utf8') <= cap) return trimmed;
    let candidate = trimmed;
    while (Buffer.byteLength(candidate, 'utf8') > cap - 8 && candidate.length > 0) {
        candidate = candidate.slice(0, -32);
    }
    return `${candidate}…`;
}

/**
 * Render one entity (work-role / project / education) as a compact summary
 * block — spine line + bullet texts + scratchpad excerpt. Capped per-entity
 * so a verbose role can't dominate the profile summary.
 */
function renderEntitySection(
    label: string,
    spine: string,
    bullets: ReadonlyArray<{ text: string; excluded?: boolean }>,
    scratchpad: string | null | undefined,
): CompactSection {
    const lines: string[] = [spine];
    const eligible = bullets.filter(b => !b.excluded);
    if (eligible.length > 0) {
        for (const b of eligible.slice(0, 5)) {
            lines.push(`  • ${b.text.trim()}`);
        }
        if (eligible.length > 5) lines.push(`  • (+${eligible.length - 5} more bullets)`);
    }
    const sp = clip(scratchpad, 300);
    if (sp) lines.push(`  notes: ${sp}`);
    return {
        label,
        body: clip(lines.join('\n'), SUMMARY_PER_ENTITY_CAP_BYTES),
    };
}

/**
 * Build the compact profile-summary string the prompt's `{{profileSummary}}`
 * substitutes. Order: top-line identity → roles → projects → education →
 * skills/hobbies/languages.
 */
export function buildProfileSummary(profile: HydratedProfile): string {
    const sections: string[] = [];

    // Identity essentials. Story S7.14 follow-up (2026-05-26): the legacy
    // `summary` column was dropped, so identity is just the name — every
    // other pitch lives in the tagline (which is the OUTPUT of this caller,
    // not its input grounding).
    const identity: string[] = [];
    if (profile.headline?.trim()) identity.push(`Name: ${profile.headline.trim()}`);
    if (identity.length > 0) sections.push(['## Identity', ...identity].join('\n'));

    // Work roles.
    if (profile.workRoles.length > 0) {
        const blocks = profile.workRoles.map((r) => {
            const spine = `${r.title} at ${r.company}${r.location ? ` (${r.location})` : ''}`;
            const scratchpad = (r as unknown as { scratchpad?: string | null }).scratchpad ?? null;
            return renderEntitySection(`work-role:${r.id}`, spine, r.bullets, scratchpad).body;
        });
        sections.push(['## Work history', ...blocks].join('\n\n'));
    }

    // Projects.
    if (profile.projects.length > 0) {
        const blocks = profile.projects.map((p) => {
            const spine = `Project: ${p.name}${p.description ? ` — ${clip(p.description, 100)}` : ''}`;
            const scratchpad = (p as unknown as { scratchpad?: string | null }).scratchpad ?? null;
            return renderEntitySection(`project:${p.id}`, spine, p.bullets, scratchpad).body;
        });
        sections.push(['## Projects', ...blocks].join('\n\n'));
    }

    // Education.
    if (profile.education.length > 0) {
        const blocks = profile.education.map((e) => {
            const spine = `${e.degree ?? 'Education'}${e.field ? ` in ${e.field}` : ''} at ${e.institution}`;
            const scratchpad = (e as unknown as { scratchpad?: string | null }).scratchpad ?? null;
            return renderEntitySection(`education:${e.id}`, spine, e.bullets, scratchpad).body;
        });
        sections.push(['## Education', ...blocks].join('\n\n'));
    }

    // Skills + hobbies + languages.
    const aside: string[] = [];
    if (profile.skills && profile.skills.length > 0) {
        const flat = profile.skills
            .map(g => `${g.category}: ${g.items.join(', ')}`)
            .join('; ');
        aside.push(`Skills: ${clip(flat, 400)}`);
    }
    if (profile.hobbies && profile.hobbies.length > 0) {
        aside.push(`Hobbies: ${profile.hobbies.join(', ')}`);
    }
    if (profile.languages && profile.languages.length > 0) {
        aside.push(`Languages: ${profile.languages.map(l => `${l.name} (${l.proficiency})`).join(', ')}`);
    }
    if (aside.length > 0) sections.push(['## Skills · Hobbies · Languages', ...aside].join('\n'));

    return sections.join('\n\n');
}

/**
 * Post-filter the model's output: trim, strip trailing newlines / quotes,
 * ensure trailing period, truncate to the hard cap if over-shot. Returns
 * the cleaned tagline (never empty — caller throws if model returns blank).
 */
export function postFilterTagline(raw: string): string {
    let t = raw.trim();
    // Strip wrapping quotes the model sometimes adds.
    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
        t = t.slice(1, -1).trim();
    }
    // Collapse internal newlines to a single space — taglines are one line.
    t = t.replace(/\s*\n\s*/g, ' ').trim();
    // Hard truncate at the cap. Try to truncate at a word boundary to avoid
    // mid-word cuts, then re-add the period.
    if (t.length > TAGLINE_HARD_CAP) {
        let cut = t.slice(0, TAGLINE_HARD_CAP - 1);
        const lastSpace = cut.lastIndexOf(' ');
        if (lastSpace > TAGLINE_HARD_CAP * 0.7) cut = cut.slice(0, lastSpace);
        t = cut.replace(/[.,;:!?]+$/, '');
    }
    // Ensure a trailing period (allow ! and ?) — the prompt asks for one
    // sentence ending with a period; the model usually obliges but we
    // defend-in-depth.
    if (!/[.!?]$/.test(t)) t = `${t}.`;
    return t;
}

// ============================================================================
// Caller
// ============================================================================

/**
 * Draft (or enhance) the user's profile tagline. Returns the cleaned
 * proposal + the dispatched mode + duration. Pure read — does NOT persist.
 * Throws on Gemini errors; route wraps in try/catch.
 */
export async function draftTagline(input: DraftTaglineInput): Promise<DraftTaglineResult> {
    const start = Date.now();
    const profile = await findOrCreateProfile(input.userId);

    const currentTagline = (profile as unknown as { tagline?: string | null }).tagline ?? null;
    const trimmedCurrent = (currentTagline ?? '').trim();
    const mode: TaglineDraftMode = trimmedCurrent.length > 0 ? 'enhance' : 'draft';

    const profileSummary = buildProfileSummary(profile);

    const prompt = await loadPrompt('tagline-draft', {
        // Capitalize the imperative verb for proper sentence-start in the
        // user template ("Draft a one-sentence…" / "Enhance a one-sentence…").
        mode: mode === 'draft' ? 'Draft' : 'Enhance',
        currentTagline: trimmedCurrent || '(none — draft from scratch)',
        profileSummary,
    });

    const response = await chatJSON({
        name: 'tagline-draft',
        system: prompt.system,
        user: prompt.user,
        schema: ResponseSchema,
        model: prompt.model ?? MODEL_LITE,
        maxOutputTokens: prompt.maxOutputTokens ?? SYNTH_MAX_OUTPUT_TOKENS,
        temperature: prompt.temperature ?? SYNTH_TEMPERATURE,
    });

    const tagline = postFilterTagline(response.tagline);
    const durationMs = Date.now() - start;

    console.info(
        `[LLM] tagline-draft:${mode} → ${tagline.length} chars in ${durationMs}ms`,
    );

    return { tagline, mode, durationMs };
}
