/**
 * M8.5.3 — Auto-tag pass for tailored resume generation (story S8.9).
 *
 * One call per resume generate. Walks every bullet in the profile (across
 * WorkRoles + Projects + Educations), asks Gemini which posting keywords
 * each bullet already evidences, and writes the approved keywords back into
 * the bullet's `tags` (so the selector sees them) AND `autoTags` (so the
 * UI badges them as pending user review — Decision 6.3).
 *
 * Hard invariants:
 *   1. No fabrication — the LLM only tags what the bullet text already
 *      supports. Enforced via the system prompt (`bullet-tags-from-posting.md` rule 1)
 *      and again at the post-filter step in `mergeAutoTagProposals`.
 *   2. Per-bullet blocklist (Decision 6.1) — keywords in `bullet.removedTags`
 *      are never proposed. The system prompt enforces this; the merge step
 *      enforces it too as defense-in-depth.
 *   3. Excluded bullets are never sent to the LLM (the user marked them
 *      "never include on a resume" — auto-tagging them would be a waste).
 *
 * Split:
 *   - `mergeAutoTagProposals(bullets, proposals)` is a PURE function. Same
 *     bullets in, same bullets out, no side effects. The hermetic smoke
 *     `scripts/tests/hermetic/auto-tag-merge-smoke.ts` exercises it in
 *     isolation (no Prisma, no Gemini, no env vars).
 *   - `autoTagBullets({...})` is the IMPURE orchestrator: loads profile via
 *     `findOrCreateProfile`, calls Gemini, merges, persists via Prisma.
 */

import { z } from 'zod';
import { chatJSON, MODEL_LITE } from '@/lib/ai/gemini';
import { loadPrompt } from '@/lib/ai/prompts';
import { prisma } from '@/lib/prisma';
import { findOrCreateProfile } from '@/lib/repositories/profile';
import { serializeBullets } from '@/lib/profile/bullets';
import type { Bullet } from '@/lib/profile/types';

// ============================================================================
// Types — shared between the pure merge step and the orchestrator
// ============================================================================

export type AutoTagParentKind = 'work-role' | 'project' | 'education';

/**
 * Flattened bullet record — what gets shipped into the prompt's `{{bullets}}`
 * variable and what `mergeAutoTagProposals` walks. Carries the parent triple
 * so the orchestrator can group merged bullets back into their owning entity
 * for the persistence step.
 */
export interface FlatBullet {
    parentKind: AutoTagParentKind;
    parentId: string;
    bullet: Bullet;
}

/**
 * LLM output: one entry per bullet that earned at least one new tag. Bullets
 * the model decided need no new tags are omitted from `proposals` entirely.
 */
export interface AutoTagProposal {
    bulletId: string;
    addedTags: string[];
}

const AutoTagResponseSchema = z.object({
    proposals: z.array(
        z.object({
            bulletId: z.string().min(1),
            addedTags: z.array(z.string()),
        }),
    ),
});

// ============================================================================
// Pure section — mergeAutoTagProposals + render helpers
// ============================================================================

/**
 * Render the `{{keywords}}` block — one keyword per line, prefixed with `  - `.
 * Matches the posting-keywords block format used by `resume-rewrite.md`.
 */
export function renderKeywordsBlock(keywords: readonly string[]): string {
    return keywords.map(k => `  - ${k}`).join('\n');
}

/**
 * Render the `{{bullets}}` block — one line per bullet. Each line carries
 * the bullet id, text, current tags, and current removedTags so the model
 * can apply the no-fabrication + blocklist + already-tagged rules without
 * extra round-trips.
 */
export function renderBulletsBlock(flat: readonly FlatBullet[]): string {
    return flat
        .map(({ bullet }) => {
            const tags = bullet.tags.map(t => JSON.stringify(t)).join(', ');
            // Escape only embedded double quotes; the surrounding `text="..."`
            // delimiter is the only thing that needs protecting. Single-line
            // per bullet — the model parses positionally, not over multi-line
            // blocks.
            const text = bullet.text.replace(/"/g, '\\"').replace(/\r?\n/g, ' ');
            // Omit removedTags entirely when empty — most bullets have no
            // blocklist, and the post-filter in mergeAutoTagProposals enforces
            // rule 3 server-side regardless of what the prompt sees.
            if (bullet.removedTags.length === 0) {
                return `- id=${bullet.id}; text="${text}"; tags=[${tags}]`;
            }
            const removed = bullet.removedTags.map(t => JSON.stringify(t)).join(', ');
            return `- id=${bullet.id}; text="${text}"; tags=[${tags}]; removedTags=[${removed}]`;
        })
        .join('\n');
}

/**
 * Flatten a profile's bullets into the orchestrator-friendly triple form.
 * Excluded bullets (`bullet.excluded === true`) are filtered out — the LLM
 * never sees them, the merge step never receives them.
 */
export function flattenProfileBullets(profile: {
    workRoles: ReadonlyArray<{ id: string; bullets: ReadonlyArray<Bullet> }>;
    projects: ReadonlyArray<{ id: string; bullets: ReadonlyArray<Bullet> }>;
    education: ReadonlyArray<{ id: string; bullets: ReadonlyArray<Bullet> }>;
}): FlatBullet[] {
    const out: FlatBullet[] = [];
    for (const wr of profile.workRoles) {
        for (const b of wr.bullets) {
            if (b.excluded) continue;
            out.push({ parentKind: 'work-role', parentId: wr.id, bullet: b });
        }
    }
    for (const p of profile.projects) {
        for (const b of p.bullets) {
            if (b.excluded) continue;
            out.push({ parentKind: 'project', parentId: p.id, bullet: b });
        }
    }
    for (const e of profile.education) {
        for (const b of e.bullets) {
            if (b.excluded) continue;
            out.push({ parentKind: 'education', parentId: e.id, bullet: b });
        }
    }
    return out;
}

/**
 * Pure merge step — applies LLM proposals to a flattened bullet list. For
 * each proposal:
 *   1. Locate the bullet by `bulletId`. Drop unknown ids silently.
 *   2. Dedup the proposal's `addedTags` (the model occasionally returns the
 *      same kw twice in one proposal).
 *   3. Filter out any kw already in `bullet.tags` (rule 2 — already there)
 *      OR in `bullet.removedTags` (rule 3 — explicitly blocked). Belt-and-
 *      braces against rule-violating model outputs.
 *   4. Drop proposals whose `addedTags` is empty after filtering.
 *   5. Merge the surviving tags into BOTH `bullet.tags` (so the selector
 *      sees them) AND `bullet.autoTags` (so the UI badges them as pending
 *      review per Decision 6.3).
 *
 * Returns a new `FlatBullet[]` — input is not mutated. Returns the unchanged
 * bullets too (in their original positions) so the caller can serialize
 * back into the parent rows verbatim.
 *
 * Also returns aggregate counters for the orchestrator's summary log.
 */
export function mergeAutoTagProposals(
    flat: readonly FlatBullet[],
    proposals: readonly AutoTagProposal[],
): { merged: FlatBullet[]; tagsAdded: number; bulletsAffected: number } {
    const proposalsByBulletId = new Map<string, AutoTagProposal>();
    for (const p of proposals) {
        proposalsByBulletId.set(p.bulletId, p);
    }

    let tagsAdded = 0;
    let bulletsAffected = 0;

    const merged = flat.map((entry): FlatBullet => {
        const proposal = proposalsByBulletId.get(entry.bullet.id);
        if (!proposal) return entry;

        // Case-insensitive dedup. The posting-keyword block uses the
        // posting's titlecasing ("Software Engineering") while user-typed
        // tags are lowercased by the UI ("software engineering"). A
        // case-sensitive Set would treat them as distinct and double-tag
        // the bullet. Compare lowercased; keep the EXISTING casing (no DB
        // churn).
        const tagSetLower = new Set(entry.bullet.tags.map(t => t.toLowerCase()));
        const removedSetLower = new Set(entry.bullet.removedTags.map(t => t.toLowerCase()));
        const dedupLower = new Set<string>();
        const filtered: string[] = [];
        for (const kw of proposal.addedTags) {
            const lk = kw.toLowerCase();
            if (tagSetLower.has(lk)) continue;
            if (removedSetLower.has(lk)) continue;
            if (dedupLower.has(lk)) continue;
            dedupLower.add(lk);
            filtered.push(kw);
        }

        if (filtered.length === 0) return entry;

        const newTags = [...entry.bullet.tags, ...filtered];
        const newAutoTags = Array.from(new Set([...entry.bullet.autoTags, ...filtered]));

        tagsAdded += filtered.length;
        bulletsAffected += 1;

        return {
            ...entry,
            bullet: {
                ...entry.bullet,
                tags: newTags,
                autoTags: newAutoTags,
            },
        };
    });

    return { merged, tagsAdded, bulletsAffected };
}

// ============================================================================
// Impure section — orchestrator
// ============================================================================

const AUTO_TAG_MAX_OUTPUT_TOKENS = 2_048;
const AUTO_TAG_TEMPERATURE = 0.1;

export interface AutoTagInput {
    userId: string;
    postingKeywords: readonly string[];
}

export interface AutoTagResult {
    tagsAdded: number;
    bulletsAffected: number;
    durationMs: number;
}

/**
 * Run the auto-tag pass for one user against one posting's keywords. Loads
 * their profile, asks Gemini which keywords each bullet already evidences,
 * merges the approved tags back, and persists via a single transaction.
 *
 * Returns the summary counters. Callers (currently `lib/resumes/generate.ts`
 * via M8.5.4) log them and surface the count in the resume-card UI.
 */
export async function autoTagBullets(input: AutoTagInput): Promise<AutoTagResult> {
    const start = Date.now();
    const keywords = input.postingKeywords.filter(k => k.trim().length > 0);

    // Short-circuit — no keywords means no tags to add, no LLM call.
    if (keywords.length === 0) {
        return { tagsAdded: 0, bulletsAffected: 0, durationMs: 0 };
    }

    const profile = await findOrCreateProfile(input.userId);

    // Profile.workRoles / projects / education each hold Hydrated* rows whose
    // `bullets` field is already a parsed Bullet[]. flattenProfileBullets
    // drops excluded bullets and emits the {parentKind, parentId, bullet} triples.
    const flat = flattenProfileBullets({
        workRoles: profile.workRoles,
        projects: profile.projects,
        education: profile.education,
    });

    // No bullets to consider → nothing to do.
    if (flat.length === 0) {
        return { tagsAdded: 0, bulletsAffected: 0, durationMs: Date.now() - start };
    }

    const prompt = await loadPrompt('bullet-tags-from-posting', {
        keywords: renderKeywordsBlock(keywords),
        bullets: renderBulletsBlock(flat),
    });

    if (!prompt.system) {
        throw new Error('auto-tag: registry template bullet-tags-from-posting has no system message');
    }

    const response = await chatJSON({
        name: 'bullet-tags-from-posting',
        system: prompt.system,
        user: prompt.user,
        schema: AutoTagResponseSchema,
        model: MODEL_LITE,
        maxOutputTokens: AUTO_TAG_MAX_OUTPUT_TOKENS,
        temperature: AUTO_TAG_TEMPERATURE,
    });

    const { merged, tagsAdded, bulletsAffected } = mergeAutoTagProposals(
        flat,
        response.proposals,
    );

    console.info(
        `[LLM] bullet-tags-from-posting:user=${input.userId}: ${tagsAdded} tag(s) across ${bulletsAffected} bullet(s) of ${flat.length} considered`,
    );

    if (bulletsAffected === 0) {
        return { tagsAdded, bulletsAffected, durationMs: Date.now() - start };
    }

    // Build the per-entity write set. Group merged bullets by (parentKind,
    // parentId). For each affected parent, reconstruct the full bullet array
    // — including any excluded bullets we filtered out for the LLM call —
    // and serialize. Unmodified parents are skipped.
    interface EntityWrite {
        kind: AutoTagParentKind;
        id: string;
        bullets: Bullet[];
    }

    // First, collect every merged bullet by parent. Within a parent, we need
    // the full bullet ordering — including the excluded ones — so we walk
    // the original profile rather than the flattened list.
    const mergedById = new Map<string, Bullet>();
    for (const entry of merged) {
        mergedById.set(entry.bullet.id, entry.bullet);
    }

    // Identify which parents had at least one bullet change. Without this we'd
    // re-serialize every WorkRole / Project / Education on the user's profile
    // even when only one bullet on one of them mutated — N round-trips for no
    // reason, and the Prisma transaction would balloon.
    const affectedParents = new Set<string>(); // key: `${kind}::${id}`
    {
        // Re-walk `flat` vs `merged` — same length and order, so index-pair
        // comparison flags any bullet whose reference changed (the pure merge
        // only allocates a new bullet when something actually changed).
        for (let i = 0; i < flat.length; i++) {
            if (flat[i].bullet !== merged[i].bullet) {
                affectedParents.add(`${flat[i].parentKind}::${flat[i].parentId}`);
            }
        }
    }

    const writes: EntityWrite[] = [];

    for (const wr of profile.workRoles) {
        if (!affectedParents.has(`work-role::${wr.id}`)) continue;
        const reconstructed = wr.bullets.map(b => mergedById.get(b.id) ?? b);
        writes.push({ kind: 'work-role', id: wr.id, bullets: reconstructed });
    }
    for (const p of profile.projects) {
        if (!affectedParents.has(`project::${p.id}`)) continue;
        const reconstructed = p.bullets.map(b => mergedById.get(b.id) ?? b);
        writes.push({ kind: 'project', id: p.id, bullets: reconstructed });
    }
    for (const e of profile.education) {
        if (!affectedParents.has(`education::${e.id}`)) continue;
        const reconstructed = e.bullets.map(b => mergedById.get(b.id) ?? b);
        writes.push({ kind: 'education', id: e.id, bullets: reconstructed });
    }

    // Single transaction — partial failure shouldn't leave the profile in a
    // half-tagged state.
    await prisma.$transaction(
        writes.map(w => {
            const data = { bullets: serializeBullets(w.bullets) };
            if (w.kind === 'work-role') {
                return prisma.workRole.update({ where: { id: w.id }, data });
            }
            if (w.kind === 'project') {
                return prisma.project.update({ where: { id: w.id }, data });
            }
            return prisma.education.update({ where: { id: w.id }, data });
        }),
    );

    return { tagsAdded, bulletsAffected, durationMs: Date.now() - start };
}
