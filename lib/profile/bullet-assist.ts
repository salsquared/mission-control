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
 * (`renderSpine`, `renderSiblingBullets`, `renderArchiveSpans`,
 * `renderReadme`) are exported so smokes can drive them with canned inputs.
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
 *   4. README excerpt (Project parents only).
 *   5. (Rewrite mode) Current bullet text + tags.
 *   6. Output schema.
 *
 * Sections 1, 5, 6 + guardrails are never trimmed. When the prompt overflows
 * the 8 KB cap, archive spans (3) are dropped first (lowest-priority outside
 * structural pieces), then siblings (2), then README (4).
 */

import { z } from 'zod';
import { chatJSON, MODEL_LITE } from '@/lib/ai/gemini';
import { newBulletId } from '@/lib/profile/bullets';
import type { Bullet } from '@/lib/profile/types';
import type { ArchiveSpan } from '@/lib/profile/upload-archive';

// ============================================================================
// Pure section — prompt builder + render helpers (M7.6.5)
// ============================================================================

export type AssistMode = 'fill' | 'rewrite';
export type ParentKind = 'work-role' | 'project' | 'education';

/**
 * Single-project README context for the bullet-assist prompt. Distinct from
 * the `ProjectReadmeContext` in `lib/resumes/rewrite.ts` — that one is
 * multi-source (resume rewrite operates on a selection across many projects);
 * bullet-assist is per-entry, so a single excerpt is the right shape.
 *
 * The caller pre-truncates the excerpt to 2 KB before passing it in.
 */
export interface ProjectReadmeContext {
    projectId: string;
    projectName: string;
    excerpt: string;
}

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
    readmeContext?: ProjectReadmeContext | null;
    currentBullet?: { text: string; tags: string[] } | null; // required when mode === 'rewrite'
}

// Section size caps. Total user-prompt ceiling is 8 KB (USER_PROMPT_LIMIT).
const SIBLING_CAP_BYTES = 1_536; // 1.5 KB
const ARCHIVE_CAP_BYTES = 1_536; // 1.5 KB
const README_CAP_BYTES = 2_048; // 2 KB
const SIBLING_COUNT_CAP = 12;
const USER_PROMPT_LIMIT = 8_192; // 8 KB

const SYSTEM_PROMPT = [
    "You are drafting or polishing professional resume bullets for the user. Output only the JSON schema requested — no preamble, no commentary.",
    '',
    'Hard rules — never violate:',
    "1. Do not invent specific quantitative claims (percentages, dollar amounts, user counts, performance numbers). If you have no source for a number, phrase the contribution qualitatively.",
    "2. Preserve the user's existing tense and voice. Do not switch to first-person.",
    "3. If you cannot produce a defensible bullet from the available context, return fewer bullets — never pad with generic filler.",
    "4. When the archive shows the same role described with different wording across versions, prefer the most concrete / metric-bearing phrasing. When the current profile has a blank that the archive fills, prefer the archive's specifics over a generic restatement.",
].join('\n');

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
 * Render the project-README excerpt section. Returns "" if `ctx` is null /
 * absent or the excerpt is empty. The caller pre-truncates to 2 KB, but we
 * defensively re-cap here so a misuse can't blow the prompt budget.
 */
export function renderReadme(ctx: ProjectReadmeContext | null | undefined, cap: number): string {
    if (!ctx) return '';
    const excerpt = (ctx.excerpt ?? '').trim();
    if (excerpt.length === 0) return '';

    const header = `## Project README — ${ctx.projectName}`;
    const full = `${header}\n${excerpt}`;
    if (Buffer.byteLength(full, 'utf8') <= cap) return full;

    // Truncate the excerpt itself byte-wise. Buffer.byteLength counts bytes,
    // not chars; for the 2 KB ceiling this is safe — we just cut on a byte
    // boundary and append a marker.
    const headerBytes = Buffer.byteLength(`${header}\n`, 'utf8');
    const remaining = Math.max(0, cap - headerBytes - 16); // 16 for the truncation marker
    // Slice characters until we're at or below the byte budget.
    let truncated = excerpt;
    while (Buffer.byteLength(truncated, 'utf8') > remaining && truncated.length > 0) {
        truncated = truncated.slice(0, -64);
    }
    return `${header}\n${truncated}\n…(truncated)`;
}

function renderTaskStatement(mode: AssistMode): string {
    if (mode === 'fill') {
        return 'Fill 3 to 5 starter bullets for this entry.';
    }
    return 'Rewrite this one bullet. Return both the new text AND updated tags reflecting the new wording — when the rewrite changes which skills / technologies / themes the bullet emphasizes, the tags should change with it.';
}

function renderCurrentBullet(current: { text: string; tags: string[] } | null | undefined): string {
    if (!current) return '';
    return [
        '## Current bullet to rewrite',
        current.text,
        `tags: [${current.tags.map((t) => JSON.stringify(t)).join(', ')}]`,
    ].join('\n');
}

function renderOutputSchema(mode: AssistMode): string {
    if (mode === 'fill') {
        return [
            '## Output schema',
            '{ "bullets": [{ "text": "<bullet text>", "tags": ["<tag1>", "<tag2>"] }, ...] }',
            'Return 3–5 bullets. Tags should be 1–3 lowercase keywords drawn from the text.',
        ].join('\n');
    }
    return [
        '## Output schema',
        '{ "text": "<rewritten bullet text>", "tags": ["<tag1>", "<tag2>"] }',
        'Return the new text plus 1–3 lowercase keyword tags reflecting the rewritten wording (typically skills, technologies, or themes the rewrite emphasizes). Keep the text length range close to the original (±20%). Tags MAY repeat the originals when the rewrite preserves the same concepts; tags MUST change when the rewrite shifts emphasis. Do not echo the id — that is preserved by the server.',
    ].join('\n');
}

/**
 * Pure prompt builder. Returns the system + user pair `chatJSON` consumes.
 *
 * Section order in `user`:
 *   1. Task statement
 *   2. Parent spine (never trimmed)
 *   3. Sibling bullets (trimmable)
 *   4. Archive spans (trimmable — dropped first on overflow)
 *   5. README excerpt (trimmable)
 *   6. Current bullet (rewrite mode only, never trimmed)
 *   7. Output schema (never trimmed)
 *
 * If the assembled `user` exceeds USER_PROMPT_LIMIT bytes, trim in this
 * priority (lowest-value first): archive spans → siblings → README.
 */
export function buildBulletAssistPrompt(
    input: BuildBulletAssistPromptInput,
): { system: string; user: string } {
    const taskStatement = renderTaskStatement(input.mode);
    const spine = renderSpine(input.parent);
    const currentBullet = input.mode === 'rewrite' ? renderCurrentBullet(input.currentBullet) : '';
    const outputSchema = renderOutputSchema(input.mode);

    // Start with full caps for the trimmable sections.
    let siblingsSection = renderSiblingBullets(input.siblingBullets, SIBLING_CAP_BYTES);
    let archiveSection = renderArchiveSpans(input.archiveSpans, ARCHIVE_CAP_BYTES);
    let readmeSection = renderReadme(input.readmeContext ?? null, README_CAP_BYTES);

    const assemble = (): string => {
        const parts: string[] = [taskStatement, '', spine];
        if (siblingsSection) parts.push('', siblingsSection);
        if (archiveSection) parts.push('', archiveSection);
        if (readmeSection) parts.push('', readmeSection);
        if (currentBullet) parts.push('', currentBullet);
        parts.push('', outputSchema);
        return parts.join('\n');
    };

    let user = assemble();

    // Overflow trim — drop in priority order (lowest value first).
    if (Buffer.byteLength(user, 'utf8') > USER_PROMPT_LIMIT) {
        archiveSection = '';
        user = assemble();
    }
    if (Buffer.byteLength(user, 'utf8') > USER_PROMPT_LIMIT) {
        siblingsSection = '';
        user = assemble();
    }
    if (Buffer.byteLength(user, 'utf8') > USER_PROMPT_LIMIT) {
        readmeSection = '';
        user = assemble();
    }

    // Spine + task + current bullet + schema are never trimmed — at this
    // point the prompt is as small as it gets. If it's still over budget
    // (extremely unlikely; would require a multi-KB spine), accept it; the
    // route will see a MAX_TOKENS error from Gemini and surface it.

    return { system: SYSTEM_PROMPT, user };
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

const RewriteResponseSchema = z.object({
    text: z.string().min(1).max(2_000),
    // Tags default to [] when the LLM omits them — keeps a malformed response
    // from blocking the rewrite. The route still applies whatever the LLM
    // returned (possibly empty); the user can hand-edit tags after Accept.
    tags: z.array(z.string()).default([]),
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
        system: input.prompt.system,
        user: input.prompt.user,
        schema: RewriteResponseSchema,
        model: BULLET_MODEL,
        maxOutputTokens: REWRITE_MAX_OUTPUT_TOKENS,
        temperature: TEMPERATURE,
    });

    const proposal: Bullet = {
        id: input.currentBullet.id,
        text: response.text,
        // LLM-supplied tags reflecting the new wording. Empty LLM response →
        // empty tags (the user can re-tag manually after Accept). This is a
        // deliberate change from the original M7.6 design which preserved the
        // original bullet's tags verbatim — the rewrite often shifts emphasis,
        // and the tags should follow.
        tags: response.tags,
        locked: input.currentBullet.locked,
        excluded: input.currentBullet.excluded,
    };

    return { mode: 'rewrite', proposal };
}
