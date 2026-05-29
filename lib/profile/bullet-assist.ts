/**
 * M7.6.5 + M7.6.6 — Bullet assist prompt builder + Gemini caller.
 *
 * Single file by design — the pure prompt builder (top half) and the impure
 * Gemini caller (bottom half) share a tight interface and a small surface of
 * types. Splitting them across files would force re-declaring the same
 * `AssistMode` / `ParentKind` / `AssistParent` types twice.
 *
 * Top half is pure: no I/O, no Date.now, no crypto. The route generates new
 * bullet ids itself after `callBulletAssist` returns. The pure helpers
 * (`renderSpine`, `renderSiblingBullets`, `renderArchiveSpans`) are exported
 * so smokes can drive them with canned inputs.
 *
 * Bottom half is impure: hits Gemini via `chatJSON`, generates fresh bullet
 * ids (fill mode) via `newBulletId` from `lib/profile/bullets.ts`, and logs
 * a single `[LLM] bullet-assist:<mode>:<kind>:<id>` line per call.
 *
 * Grounding surface (per docs/implementation.md §M7.6, in priority order
 * highest → lowest for the trim-on-overflow step):
 *   1. Spine fields of the parent entity.
 *   2. Sibling bullets in the same profile (the user's own voice).
 *   3. Archive spans from prior resume uploads (S7.9 grounding).
 *   4. Parent scratchpad (the user's own notes about this entity).
 *   5. (Rewrite mode) Current bullet text + tags.
 *   6. Output schema.
 *
 * Sections 1, 5, 6 + guardrails are never trimmed. When the prompt overflows
 * the 8 KB cap, archive spans (3) are dropped first (lowest-priority outside
 * structural pieces), then siblings (2); scratchpad drops last.
 */

import { z } from 'zod';
import { chatJSON, MODEL_LITE } from '@/lib/ai/gemini';
import { loadPrompt } from '@/lib/ai/prompts';
import { newBulletId } from '@/lib/profile/bullets';
import type { Bullet } from '@/lib/profile/types';
import type { ArchiveSpan } from '@/lib/profile/upload-archive';

// ============================================================================
// Pure section — prompt builder + render helpers (M7.6.5)
// ============================================================================

export type AssistMode = 'fill' | 'rewrite';
export type ParentKind = 'work-role' | 'project' | 'education';

export interface AssistParent {
    kind: ParentKind;
    id: string;
    // Spine fields — only those relevant to `kind` are populated. The route
    // builds this object from the loaded Prisma row, so unrelated fields stay
    // undefined.
    company?: string | null; // work-role
    title?: string | null; // work-role
    location?: string | null; // work-role / education
    startDate?: string | null; // ISO date string or null
    endDate?: string | null; // ISO date string or null (null === "Present")
    // Project-specific
    name?: string | null;
    description?: string | null;
    repoUrl?: string | null;
    liveUrl?: string | null;
    // Education-specific
    institution?: string | null;
    degree?: string | null;
    field?: string | null;
}

export interface SiblingInput {
    text: string;
    tags: string[];
}

export interface BuildBulletAssistPromptInput {
    mode: AssistMode;
    parent: AssistParent;
    siblingBullets: SiblingInput[]; // pre-filtered + ranked by caller; capped to first ~12 inside
    archiveSpans: ArchiveSpan[]; // already top-3 ranked by recency (from findArchiveSpansFor)
    /** M7.8.5 (story S7.13) — the parent entity's own scratchpad text. Voice
     *  + experience grounding the user wrote in their own words. The caller
     *  reads `WorkRole.scratchpad` / `Project.scratchpad` / `Education.scratchpad`
     *  and passes it through. Empty string or null = no section rendered.
     *  Cross-entity isolation is enforced at the caller layer — this field
     *  ONLY ever receives the current parent's own scratchpad. */
    parentScratchpad?: string | null;
    currentBullet?: { text: string; tags: string[] } | null; // required when mode === 'rewrite'
}

// Section size caps. Total user-prompt ceiling is 8 KB (USER_PROMPT_LIMIT).
const SIBLING_CAP_BYTES = 1_536; // 1.5 KB
const ARCHIVE_CAP_BYTES = 1_536; // 1.5 KB
// M7.8.5 — scratchpad caps at 2 KB for the prompt (full column is up to 8 KB).
// The 2 KB excerpt is the user's own raw notes; truncating from the end is
// the right call because users typically lead with the most important
// context.
const SCRATCHPAD_CAP_BYTES = 2_048; // 2 KB
const SIBLING_COUNT_CAP = 12;
const USER_PROMPT_LIMIT = 8_192; // 8 KB

/**
 * Render the parent entity's spine fields as a markdown-style list. Skips
 * null / empty values and only includes fields relevant to the parent kind.
 */
export function renderSpine(parent: AssistParent): string {
    const lines: string[] = ['## Entry'];

    const push = (label: string, value: string | null | undefined): void => {
        if (value == null) return;
        const trimmed = String(value).trim();
        if (trimmed.length === 0) return;
        lines.push(`- ${label}: ${trimmed}`);
    };

    lines.push(`- Kind: ${parent.kind}`);

    if (parent.kind === 'work-role') {
        push('Company', parent.company);
        push('Title', parent.title);
        push('Location', parent.location);
        push('Start date', parent.startDate);
        push('End date', parent.endDate ?? 'Present');
    } else if (parent.kind === 'project') {
        push('Name', parent.name);
        push('Description', parent.description);
        push('Repo URL', parent.repoUrl);
        push('Live URL', parent.liveUrl);
        push('Start date', parent.startDate);
        push('End date', parent.endDate ?? 'Present');
    } else {
        // education
        push('Institution', parent.institution);
        push('Degree', parent.degree);
        push('Field', parent.field);
        push('Location', parent.location);
        push('Start date', parent.startDate);
        push('End date', parent.endDate ?? 'Present');
    }

    return lines.join('\n');
}

/**
 * Render the sibling-bullet section, trimming entries from the END until the
 * total byte length fits inside `cap`. Returns "" when no siblings survive
 * the trim (the caller will omit the header entirely).
 *
 * Why trim from the end: the caller pre-ranks siblings by tag-overlap /
 * relevance, so the most useful voice samples are at the front of the list.
 */
export function renderSiblingBullets(siblings: SiblingInput[], cap: number): string {
    if (siblings.length === 0) return '';

    // Hard count cap before byte cap — keeps the prompt readable even if every
    // bullet is one short word.
    const capped = siblings.slice(0, SIBLING_COUNT_CAP);

    const header = '## Other bullets in this profile (voice + vocabulary reference)';
    const lines = capped.map((b) => `- ${b.text}`);

    // Trim from the end until the section fits.
    while (lines.length > 0) {
        const candidate = [header, ...lines].join('\n');
        if (Buffer.byteLength(candidate, 'utf8') <= cap) {
            return candidate;
        }
        lines.pop();
    }

    return '';
}

/**
 * Render the archive-spans section. Drops trailing spans until the total
 * byte length fits inside `cap`. Returns "" if no spans survive.
 *
 * Each span is trimmed to a single paragraph — newlines collapsed to one
 * space — so the section reads as prose, not a salad of resume fragments.
 */
export function renderArchiveSpans(spans: ArchiveSpan[], cap: number): string {
    if (spans.length === 0) return '';

    const header = '## Spans from prior uploaded resume versions';
    const blocks = spans.map((s) => {
        const date = s.uploadedAt instanceof Date && !Number.isNaN(s.uploadedAt.getTime())
            ? s.uploadedAt.toISOString().slice(0, 10)
            : 'unknown';
        const paragraph = s.span.replace(/\s+/g, ' ').trim();
        return `### ${s.filename} (uploaded ${date})\n${paragraph}`;
    });

    // Trim from the end until the section fits.
    while (blocks.length > 0) {
        const candidate = [header, blocks.join('\n\n')].join('\n');
        if (Buffer.byteLength(candidate, 'utf8') <= cap) {
            return candidate;
        }
        blocks.pop();
    }

    return '';
}

/**
 * M7.8.5 (story S7.13) — render the parent entity's own scratchpad as a
 * prompt section. Returns "" when scratchpad is null / empty / whitespace
 * so the prompt template omits the section header entirely (the registry
 * template uses `{{scratchpad}}` substitution; empty string yields a clean
 * gap, not a dangling header).
 *
 * Truncates from the END at the byte cap — users typically lead with the
 * most important context, so trailing trim is safer than middle-out.
 */
export function renderScratchpad(scratchpad: string | null | undefined, cap: number): string {
    if (!scratchpad) return '';
    const trimmed = scratchpad.trim();
    if (trimmed.length === 0) return '';

    const header = "## User's notes about this role/project/education (their own voice)";
    const full = `${header}\n${trimmed}`;
    if (Buffer.byteLength(full, 'utf8') <= cap) return full;

    const headerBytes = Buffer.byteLength(`${header}\n`, 'utf8');
    const remaining = Math.max(0, cap - headerBytes - 16); // 16 for marker
    let truncated = trimmed;
    while (Buffer.byteLength(truncated, 'utf8') > remaining && truncated.length > 0) {
        truncated = truncated.slice(0, -64);
    }
    return `${header}\n${truncated}\n…(truncated)`;
}

/**
 * Async prompt builder — pulls the system + user template from the prompt
 * registry (Lunary when configured, disk snapshot otherwise) and renders
 * with the assembled section variables. Same overflow contract as before:
 * drop archive → siblings in that priority order to fit within
 * USER_PROMPT_LIMIT bytes; scratchpad drops last.
 *
 * Made async at LOP-6 cutover so production reads the latest Lunary
 * version on every call (the SDK caches a few minutes). Smoke + the
 * /api/profile/bullets/assist route both need `await`.
 */
export async function buildBulletAssistPrompt(
    input: BuildBulletAssistPromptInput,
): Promise<{ system: string; user: string }> {
    const slug = input.mode === 'fill' ? 'bullet-assist-fill' : 'bullet-assist-rewrite';
    const spine = renderSpine(input.parent);
    const currentBulletText = input.currentBullet?.text ?? '';
    const currentBulletTags = input.currentBullet
        ? input.currentBullet.tags.map(t => JSON.stringify(t)).join(', ')
        : '';

    // Start with full caps for the trimmable sections.
    let siblings = renderSiblingBullets(input.siblingBullets, SIBLING_CAP_BYTES);
    let archive = renderArchiveSpans(input.archiveSpans, ARCHIVE_CAP_BYTES);
    let scratchpad = renderScratchpad(input.parentScratchpad ?? null, SCRATCHPAD_CAP_BYTES);

    const render = () => loadPrompt(slug, {
        spine,
        siblings,
        archive,
        scratchpad,
        currentBulletText,
        currentBulletTags,
    });

    let prompt = await render();

    // Overflow trim — drop in priority order (lowest value first). Re-render
    // through the registry so the byte budget is computed against the actual
    // template that will be sent. Order: archive (oldest source) → siblings
    // → scratchpad. Scratchpad ranks high because the user wrote it
    // specifically about THIS entity, so it's the most relevant grounding.
    if (Buffer.byteLength(prompt.user, 'utf8') > USER_PROMPT_LIMIT) {
        archive = '';
        prompt = await render();
    }
    if (Buffer.byteLength(prompt.user, 'utf8') > USER_PROMPT_LIMIT) {
        siblings = '';
        prompt = await render();
    }
    // Scratchpad is dropped last — it's the user's most-targeted grounding
    // for THIS entity, so we hold onto it the longest. Unlikely to ever
    // fire in practice (scratchpad cap is 2 KB; spine + schema are < 1 KB).
    if (Buffer.byteLength(prompt.user, 'utf8') > USER_PROMPT_LIMIT) {
        scratchpad = '';
        prompt = await render();
    }

    // Spine + task + current bullet + schema are never trimmed — at this
    // point the prompt is as small as it gets. If it's still over budget
    // (extremely unlikely; would require a multi-KB spine), accept it; the
    // route will see a MAX_TOKENS error from Gemini and surface it.

    if (!prompt.system) {
        throw new Error(`buildBulletAssistPrompt: registry template ${slug} has no system message`);
    }
    return { system: prompt.system, user: prompt.user };
}

// ============================================================================
// Impure section — Gemini caller (M7.6.6)
// ============================================================================

export interface FillResult {
    mode: 'fill';
    bullets: Bullet[]; // server-filled id/locked/excluded; tags + text from LLM
}

export interface RewriteResult {
    mode: 'rewrite';
    proposal: Bullet; // id/locked/excluded copied from currentBullet; text + tags from LLM
}

export interface CallBulletAssistInput {
    mode: AssistMode;
    prompt: { system: string; user: string }; // output of buildBulletAssistPrompt
    // Passed through so the caller can construct the rewrite proposal with the
    // original bullet's id / locked / excluded preserved. Tags are LLM-supplied
    // (the rewrite often shifts emphasis, and tags should follow).
    currentBullet?: Bullet | null;
    // Telemetry — used only for the `[LLM] bullet-assist:<mode>:<kind>:<id>` log line.
    parentKind: ParentKind;
    parentId: string;
}

// Allow up to 8 bullets in the LLM response; we slice to 5 after validation.
// `tags` defaults to [] so an LLM that returns text-only doesn't fail validation.
const FillResponseSchema = z.object({
    bullets: z
        .array(
            z.object({
                text: z.string().min(1),
                tags: z.array(z.string()).default([]),
            }),
        )
        .min(1)
        .max(8),
});

// M7.7.2 (story S7.10): rewrite is now TEXT-ONLY. Tags are owned by the
// tag-suggest flow (`bullet-tags-from-profile` — separate LLM callsite). The
// rewrite response schema drops the `tags` field; the proposal preserves
// the input bullet's tags / autoTags / removedTags / pinnedTags verbatim.
// This narrows S7.8 back to its original text-only intent (the M7.6
// `fffa038` enhancement that added tag churn is reverted).
const RewriteResponseSchema = z.object({
    text: z.string().min(1).max(2_000),
});

// The "3.1" SKU the user asked for. `gemini-3.1-flash` (non-lite) does NOT
// exist — Google only ships `gemini-3.1-flash-lite` at the 3.1 tier.
// MODEL_LITE is the project default for mechanical extraction work and is
// well-suited here because the user vets every output (Accept/Discard on
// rewrite, edit-before-save on fill). Reach for MODEL_FLASH (3.5) only if
// cold-start draft quality proves weak in practice.
const BULLET_MODEL = MODEL_LITE;
const FILL_MAX_OUTPUT_TOKENS = 4_096;
const REWRITE_MAX_OUTPUT_TOKENS = 2_048;
const TEMPERATURE = 0.4;
const FILL_BULLET_CAP = 5;

/**
 * Run the bullet-assist prompt through Gemini. Returns either a fill result
 * (3–5 fresh bullets with new ids) or a rewrite result (single proposal with
 * the original bullet's id/tags/locked/excluded preserved).
 *
 * Throws on zod validation failure — the route surfaces the AIError.
 */
export async function callBulletAssist(
    input: CallBulletAssistInput,
): Promise<FillResult | RewriteResult> {
    console.info(
        `[LLM] bullet-assist:${input.mode}:${input.parentKind}:${input.parentId}`,
    );

    if (input.mode === 'fill') {
        const response = await chatJSON({
            name: "bullet-assist-fill",
            // Generative: drafts NEW bullet prose — the user expects a fresh
            // take on re-ask, so opt out of cross-tier dedup.
            cache: false,
            system: input.prompt.system,
            user: input.prompt.user,
            schema: FillResponseSchema,
            model: BULLET_MODEL,
            maxOutputTokens: FILL_MAX_OUTPUT_TOKENS,
            temperature: TEMPERATURE,
        });

        const bullets: Bullet[] = response.bullets.slice(0, FILL_BULLET_CAP).map((b) => ({
            id: newBulletId(),
            text: b.text,
            tags: b.tags,
            autoTags: [],
            removedTags: [],
            pinnedTags: [],
            locked: false,
            excluded: false,
        }));

        return { mode: 'fill', bullets };
    }

    // Rewrite mode
    if (!input.currentBullet) {
        throw new Error(
            'callBulletAssist: rewrite mode requires currentBullet — caller must pass the original Bullet so id / tags / locked / excluded can be preserved on the proposal.',
        );
    }

    const response = await chatJSON({
        name: "bullet-assist-rewrite",
        // Generative: rewrites a bullet into a fresh phrasing — re-ask should
        // re-roll, so opt out of cross-tier dedup.
        cache: false,
        system: input.prompt.system,
        user: input.prompt.user,
        schema: RewriteResponseSchema,
        model: BULLET_MODEL,
        maxOutputTokens: REWRITE_MAX_OUTPUT_TOKENS,
        temperature: TEMPERATURE,
    });

    // M7.7.2 (S7.10) — text-only rewrite. Every tag-related field passes
    // through unchanged from the input bullet. Tag churn for this bullet
    // now lives in the separate `bullet-tags-from-profile` callsite (the Tags
    // icon on BulletRow, sibling to the wand). A user who wants the
    // rewrite's wording AND a tag refresh runs both flows explicitly.
    const proposal: Bullet = {
        id: input.currentBullet.id,
        text: response.text,
        tags: input.currentBullet.tags,
        autoTags: input.currentBullet.autoTags,
        removedTags: input.currentBullet.removedTags,
        pinnedTags: input.currentBullet.pinnedTags,
        locked: input.currentBullet.locked,
        excluded: input.currentBullet.excluded,
    };

    return { mode: 'rewrite', proposal };
}
