/**
 * M7.7.3 (story S7.10 + S7.11) — Per-bullet AI tag generator.
 *
 * The Tags icon on `BulletRow` (sibling to the wand) invokes this. Distinct
 * from:
 *   - `bullet-assist-rewrite` (M7.6) → text-only after M7.7.2; ignores tags.
 *   - `bullet-auto-tag` (M8.5) → bulk pass at resume-gen time across all
 *     bullets, posting-keyword-driven. This callsite is per-bullet, on-demand,
 *     and posting-agnostic.
 *
 * Inputs: bullet text + current tags categorized as pinned / auto / user +
 * the bullet's `removedTags` blocklist + profile-wide tag vocabulary.
 *
 * Output contract (`{ tags: string[] }` — the PROPOSED FINAL TAG LIST):
 *   1. Must include every pinned tag verbatim. Server re-adds any pinned
 *      tag the LLM drops (defense-in-depth against a hallucinating model).
 *   2. Never includes any tag in `removedTags`. Server strips any leaks.
 *   3. Hard cap of 7 tags. Server truncates the unpinned tail if over.
 *   4. Soft floor of 3 tags. If the LLM can't defend 3, returns what it has;
 *      no padding.
 *   5. Tags are concrete skills / technologies / methodologies — not generic
 *      adjectives. Enforced via the system prompt.
 *
 * Persistence: this helper does NOT write. The route returns the proposal to
 * the client, the client shows a diff panel (M7.7.7), Accept fires the
 * existing entity PATCH with the new tags array. `autoTags` on the persisted
 * bullet receives the *newly-added* tags (proposal.tags − original.tags) so
 * the UI badges them as pending user confirmation — same semantic as M8.5.6.
 *
 * Cap guard: this caller assumes the route already checked
 * `bullet.tags.length < 7` (M7.7.5). The route returns 400
 * `{error: 'tag-limit-reached'}` BEFORE invoking us when at cap, saving the
 * LLM round-trip. If a future caller forgets the guard, the prompt still
 * enforces ≤7 in output; the response schema doesn't (it just caps array
 * length so a runaway model can't blow token budget).
 */

import { z } from 'zod';
import { chatJSON, MODEL_LITE } from '@/lib/ai/gemini';
import { loadPrompt } from '@/lib/ai/prompts';
import { findOrCreateProfile } from '@/lib/repositories/profile';
import type { Bullet } from '@/lib/profile/types';

// ============================================================================
// Types
// ============================================================================

export type TagSuggestParentKind = 'work-role' | 'project' | 'education';

export interface SuggestTagsInput {
    userId: string;
    parentKind: TagSuggestParentKind;
    parentId: string;
    bulletId: string;
}

export interface SuggestTagsResult {
    tags: string[];
    reason?: string;
    durationMs: number;
}

// Hard cap from S7.10 — never let the proposal exceed 7 tags. Soft floor is
// 3, but a model returning fewer is acceptable (the user gets what's
// defensible; over-padding would be worse than under-filling).
const MAX_TAGS = 7;

// Top-N vocabulary entries surfaced to the LLM. Keeps the prompt bounded
// and biases toward labels the user already uses elsewhere in the profile.
// 50 covers the long tail of a real profile (typically 30–80 unique tags)
// without overflowing the 1024-token output budget on a wide vocabulary.
const VOCABULARY_TOP_N = 50;

// Bullet-text cap. Profile bullets are usually ≤ 200 chars; truncate at 500
// to guard against a runaway hand-edited bullet.
const BULLET_TEXT_CAP = 500;

const ResponseSchema = z.object({
    // `.max(20)` is an upper guardrail in case the model goes wild — we still
    // truncate to MAX_TAGS server-side, but rejecting at >20 stops a malformed
    // response from eating the whole maxOutputTokens budget on dummy strings.
    tags: z.array(z.string().min(1).max(60)).max(20),
    reason: z.string().max(500).optional(),
});

// ============================================================================
// Pure helpers — render the per-tag state list + vocabulary block
// ============================================================================

/**
 * Categorize a bullet's tags into pinned / auto / user buckets for the prompt.
 * Pinned wins over auto wins over user when a tag is in multiple lists (the
 * invariants enforce no actual overlap, but be defensive against legacy data).
 */
export function categorizeTags(bullet: Bullet): {
    pinned: string[];
    auto: string[];
    user: string[];
} {
    const pinnedSet = new Set(bullet.pinnedTags);
    const autoSet = new Set(bullet.autoTags);
    const pinned: string[] = [];
    const auto: string[] = [];
    const user: string[] = [];
    for (const tag of bullet.tags) {
        if (pinnedSet.has(tag)) pinned.push(tag);
        else if (autoSet.has(tag)) auto.push(tag);
        else user.push(tag);
    }
    return { pinned, auto, user };
}

/**
 * Render the categorized tag list as a markdown-ish block the prompt
 * template injects under `## Current tags`. Format chosen so a small LLM
 * can read the state markers cleanly without confusing them for tag text.
 */
export function renderTagState(bullet: Bullet): string {
    const { pinned, auto, user } = categorizeTags(bullet);
    const lines: string[] = [];
    for (const tag of pinned) lines.push(`  - "${tag}" [pinned — MUST remain in output verbatim]`);
    for (const tag of auto) lines.push(`  - "${tag}" [auto — may keep / replace / remove]`);
    for (const tag of user) lines.push(`  - "${tag}" [user — may keep / replace / remove]`);
    if (lines.length === 0) return '  (no tags yet — propose 3–7 from scratch grounded on the bullet text)';
    return lines.join('\n');
}

export function renderRemovedTags(bullet: Bullet): string {
    if (bullet.removedTags.length === 0) return '  (none)';
    return bullet.removedTags.map((t) => `  - "${t}"`).join('\n');
}

/**
 * Walk every bullet in the profile (across WorkRoles + Projects + Educations)
 * and build a frequency-sorted vocabulary list. Tags from the bullet being
 * tag-suggested are EXCLUDED from the vocabulary — they're already visible
 * in the per-tag state block, including them in vocabulary would be noise.
 *
 * Returns top-N tags by usage count, ties broken by alpha sort for determinism.
 */
export interface ProfileVocabularyInput {
    workRoles: Array<{ bullets: Bullet[] }>;
    projects: Array<{ bullets: Bullet[] }>;
    education: Array<{ bullets: Bullet[] }>;
}

export function computeTagVocabulary(
    profile: ProfileVocabularyInput,
    excludeTags: ReadonlySet<string>,
    topN: number = VOCABULARY_TOP_N,
): string[] {
    const counts = new Map<string, number>();
    function tally(bullets: Bullet[]): void {
        for (const b of bullets) {
            for (const tag of b.tags) {
                if (excludeTags.has(tag)) continue;
                counts.set(tag, (counts.get(tag) ?? 0) + 1);
            }
        }
    }
    for (const r of profile.workRoles) tally(r.bullets);
    for (const p of profile.projects) tally(p.bullets);
    for (const e of profile.education) tally(e.bullets);

    return Array.from(counts.entries())
        .sort((a, b) => {
            if (b[1] !== a[1]) return b[1] - a[1]; // count desc
            return a[0].localeCompare(b[0]);        // alpha asc on ties
        })
        .slice(0, topN)
        .map(([tag]) => tag);
}

export function renderVocabulary(vocab: string[]): string {
    if (vocab.length === 0) return '  (no other tags in the profile yet — invent appropriate ones)';
    return vocab.map((t) => `"${t}"`).join(', ');
}

/**
 * Apply the server-side post-filter to enforce the contract regardless of
 * what the LLM returns:
 *   1. Re-add any pinned tag the LLM dropped (defense-in-depth — the prompt
 *      already insists, but a hallucinating model could miss it).
 *   2. Strip any tag that appears in `removedTags` (blocklist wins).
 *   3. Strip any tag identical to an existing tag (dedup, preserving order
 *      via Set semantics on first occurrence).
 *   4. Truncate to MAX_TAGS, keeping pinned first then proposal order.
 *
 * Pure function. Tested without Gemini in `bullet-tag-suggest-smoke.ts`.
 */
export function applyTagSuggestPostFilter(
    proposed: string[],
    pinnedTags: string[],
    removedTags: string[],
): string[] {
    const removedSet = new Set(removedTags);
    const seen = new Set<string>();
    const result: string[] = [];

    // Pinned tags ALWAYS appear first in the output, regardless of where
    // they showed up (or didn't) in the model's response. This is the
    // S7.11 invariant in concrete form.
    for (const tag of pinnedTags) {
        if (removedSet.has(tag)) continue; // shouldn't happen — schema invariant — but defensive
        if (seen.has(tag)) continue;
        seen.add(tag);
        result.push(tag);
    }

    // Then the LLM's proposed tags in order, skipping any in the blocklist
    // or any duplicate of a pin we already emitted.
    for (const tag of proposed) {
        if (removedSet.has(tag)) continue;
        if (seen.has(tag)) continue;
        seen.add(tag);
        result.push(tag);
        if (result.length >= MAX_TAGS) break;
    }

    return result;
}

// ============================================================================
// Orchestrator — load profile, build prompt, call Gemini, post-filter
// ============================================================================

/**
 * Spine fields used in the prompt — minimal context so the LLM can ground tag
 * suggestions in what KIND of entry this is (role at a company vs. project vs.
 * education). Doesn't matter as much as `bullet.text` does, but a "Built a
 * caching layer" bullet under a Project entry implies different tagging than
 * the same bullet under a WorkRole.
 */
function buildSpine(
    parentKind: TagSuggestParentKind,
    entity: { company?: string | null; title?: string | null; name?: string | null; institution?: string | null; degree?: string | null },
): string {
    if (parentKind === 'work-role') {
        return `${entity.title ?? '(untitled role)'} at ${entity.company ?? '(unknown company)'}`;
    }
    if (parentKind === 'project') {
        return `Project: ${entity.name ?? '(unnamed)'}`;
    }
    return `${entity.degree ?? 'Education'} at ${entity.institution ?? '(unknown institution)'}`;
}

/**
 * Locate the bullet + parent in the loaded profile. Returns null on miss
 * (cross-user request, deleted entity, stale bulletId, etc.). The route
 * surfaces the null as 404 — never leak existence.
 */
type LoadedProfile = Awaited<ReturnType<typeof findOrCreateProfile>>;

function findBullet(
    profile: LoadedProfile,
    parentKind: TagSuggestParentKind,
    parentId: string,
    bulletId: string,
): { bullet: Bullet; entity: LoadedProfile['workRoles'][0] | LoadedProfile['projects'][0] | LoadedProfile['education'][0] } | null {
    const list =
        parentKind === 'work-role' ? profile.workRoles :
        parentKind === 'project' ? profile.projects :
        profile.education;
    const entity = list.find((e) => e.id === parentId);
    if (!entity) return null;
    const bullet = entity.bullets.find((b) => b.id === bulletId);
    if (!bullet) return null;
    return { bullet, entity };
}

export async function suggestTagsForBullet(input: SuggestTagsInput): Promise<SuggestTagsResult | null> {
    const t0 = Date.now();
    const profile = await findOrCreateProfile(input.userId);
    const found = findBullet(profile, input.parentKind, input.parentId, input.bulletId);
    if (!found) return null;

    const { bullet, entity } = found;

    // Truncate bullet text just for the prompt — the persisted bullet is
    // unchanged either way; we just don't want a runaway bullet to dominate
    // the prompt budget.
    const truncatedText = bullet.text.length > BULLET_TEXT_CAP
        ? bullet.text.slice(0, BULLET_TEXT_CAP) + '…'
        : bullet.text;

    const tagState = renderTagState({ ...bullet, text: truncatedText });
    const removedTagsBlock = renderRemovedTags(bullet);
    const vocab = computeTagVocabulary(profile, new Set(bullet.tags));
    const vocabBlock = renderVocabulary(vocab);
    const spine = buildSpine(input.parentKind, entity);

    const prompt = await loadPrompt('bullet-tag-suggest', {
        spine,
        bulletText: truncatedText,
        tagState,
        removedTags: removedTagsBlock,
        vocabulary: vocabBlock,
    });

    const response = await chatJSON({
        name: 'bullet-tag-suggest',
        system: prompt.system,
        user: prompt.user,
        schema: ResponseSchema,
        model: prompt.model ?? MODEL_LITE,
        maxOutputTokens: prompt.maxOutputTokens ?? 1024,
        temperature: prompt.temperature ?? 0.3,
    });

    const tags = applyTagSuggestPostFilter(response.tags, bullet.pinnedTags, bullet.removedTags);

    const durationMs = Date.now() - t0;
    console.info(
        `[LLM] bullet-tag-suggest:${input.parentKind}:${input.parentId}:${input.bulletId} → ${tags.length} tags in ${durationMs}ms`,
    );

    return { tags, reason: response.reason, durationMs };
}
