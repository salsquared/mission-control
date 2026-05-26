/**
 * M8.5.8 (partial) — Pure smoke for `mergeAutoTagProposals` from
 * `lib/profile/auto-tag.ts`. No Prisma, no Gemini, no env vars; exercises the
 * post-LLM merge step in isolation against canned proposals.
 *
 * Invariants under test:
 *   1. Empty proposals → bullets unchanged.
 *   2. Positive proposal — keyword added to `bullet.tags` AND `bullet.autoTags`.
 *   3. Already-in-tags — proposal kw already in `bullet.tags` is dropped at
 *      post-filter (defense-in-depth; LLM may violate rule 2).
 *   4. Removed-blocklist — proposal kw in `bullet.removedTags` is dropped
 *      at post-filter (defense-in-depth; LLM may violate rule 3).
 *   5. Dedup — proposal returning the same kw twice for the same bullet
 *      adds it once.
 *   6. Excluded bullets — `flattenProfileBullets` filters them out before
 *      the LLM ever sees them; the merge step is defensively a no-op on
 *      excluded bullets if the caller does pass one through.
 *   7. Unknown bulletId — proposal references a bullet not in `flat`;
 *      silently dropped, no throw.
 *   8. Reference stability — bullets the merge didn't touch share their
 *      original object reference (the orchestrator uses this to detect
 *      which parents need a Prisma write).
 *
 *   npx tsx scripts/tests/hermetic/auto-tag-merge-smoke.ts
 */

import {
    flattenProfileBullets,
    mergeAutoTagProposals,
    type AutoTagProposal,
    type FlatBullet,
} from '@/lib/profile/auto-tag';
import type { Bullet } from '@/lib/profile/types';

let passes = 0;
let fails = 0;
function pass(msg: string): void { console.log(`[PASS] ${msg}`); passes++; }
function fail(msg: string, detail?: unknown): void { console.error(`[FAIL] ${msg}`, detail ?? ''); fails++; }

function mkBullet(id: string, text: string, partial: Partial<Bullet> = {}): Bullet {
    return {
        id,
        text,
        tags: partial.tags ?? [],
        autoTags: partial.autoTags ?? [],
        removedTags: partial.removedTags ?? [],
        pinnedTags: partial.pinnedTags ?? [],
        locked: partial.locked ?? false,
        excluded: partial.excluded ?? false,
    };
}

function mkFlat(parentKind: FlatBullet['parentKind'], parentId: string, bullet: Bullet): FlatBullet {
    return { parentKind, parentId, bullet };
}

// ─── 1. Empty proposals → bullets unchanged ─────────────────────────────────
{
    const flat: FlatBullet[] = [
        mkFlat('work-role', 'wr_1', mkBullet('b1', 'Built a Python API', { tags: ['python'] })),
        mkFlat('work-role', 'wr_1', mkBullet('b2', 'Wrote Go services', { tags: ['go'] })),
    ];
    const { merged, tagsAdded, bulletsAffected } = mergeAutoTagProposals(flat, []);
    if (tagsAdded !== 0) fail('empty proposals: tagsAdded must be 0', tagsAdded);
    else if (bulletsAffected !== 0) fail('empty proposals: bulletsAffected must be 0', bulletsAffected);
    else if (merged.length !== flat.length) fail('empty proposals: merged length mismatch', merged.length);
    else if (merged[0].bullet !== flat[0].bullet) fail('empty proposals: bullet references must be stable');
    else if (merged[1].bullet !== flat[1].bullet) fail('empty proposals: bullet references must be stable');
    else pass('empty proposals leave bullets unchanged + references stable');
}

// ─── 2. Positive — kw added to tags AND autoTags ────────────────────────────
{
    const original = mkBullet('b1', 'Built a Python API');
    const flat: FlatBullet[] = [mkFlat('work-role', 'wr_1', original)];
    const proposals: AutoTagProposal[] = [
        { bulletId: 'b1', addedTags: ['Python'] },
    ];
    const { merged, tagsAdded, bulletsAffected } = mergeAutoTagProposals(flat, proposals);
    if (tagsAdded !== 1) fail('positive: tagsAdded must be 1', tagsAdded);
    else if (bulletsAffected !== 1) fail('positive: bulletsAffected must be 1', bulletsAffected);
    else if (!merged[0].bullet.tags.includes('Python')) fail('positive: tags must include Python', merged[0].bullet.tags);
    else if (!merged[0].bullet.autoTags.includes('Python')) fail('positive: autoTags must include Python', merged[0].bullet.autoTags);
    else if (merged[0].bullet === original) fail('positive: bullet reference must change when modified');
    else pass('positive proposal adds to tags + autoTags + allocates new ref');
}

// ─── 3. Already-in-tags — defense-in-depth ──────────────────────────────────
{
    const original = mkBullet('b1', 'Built a Python API', { tags: ['Python'] });
    const flat: FlatBullet[] = [mkFlat('work-role', 'wr_1', original)];
    const proposals: AutoTagProposal[] = [
        { bulletId: 'b1', addedTags: ['Python'] },
    ];
    const { merged, tagsAdded, bulletsAffected } = mergeAutoTagProposals(flat, proposals);
    if (tagsAdded !== 0) fail('already-tagged: tagsAdded must be 0 after filter', tagsAdded);
    else if (bulletsAffected !== 0) fail('already-tagged: bulletsAffected must be 0', bulletsAffected);
    else if (merged[0].bullet.tags.filter(t => t === 'Python').length !== 1) fail('already-tagged: Python must appear exactly once', merged[0].bullet.tags);
    else if (merged[0].bullet.autoTags.includes('Python')) fail('already-tagged: autoTags must NOT gain a kw that was already in tags', merged[0].bullet.autoTags);
    else if (merged[0].bullet !== original) fail('already-tagged: bullet reference must be stable when no changes applied');
    else pass('already-tagged kw is dropped at post-filter; autoTags untouched');
}

// ─── 4. Removed-blocklist — defense-in-depth ────────────────────────────────
{
    const original = mkBullet('b1', 'Built a Python API', { removedTags: ['Python'] });
    const flat: FlatBullet[] = [mkFlat('work-role', 'wr_1', original)];
    const proposals: AutoTagProposal[] = [
        { bulletId: 'b1', addedTags: ['Python'] },
    ];
    const { merged, tagsAdded, bulletsAffected } = mergeAutoTagProposals(flat, proposals);
    if (tagsAdded !== 0) fail('removed-blocklist: tagsAdded must be 0', tagsAdded);
    else if (bulletsAffected !== 0) fail('removed-blocklist: bulletsAffected must be 0', bulletsAffected);
    else if (merged[0].bullet.tags.includes('Python')) fail('removed-blocklist: tags must NOT acquire blocklisted kw', merged[0].bullet.tags);
    else if (merged[0].bullet.autoTags.includes('Python')) fail('removed-blocklist: autoTags must NOT acquire blocklisted kw', merged[0].bullet.autoTags);
    else if (merged[0].bullet !== original) fail('removed-blocklist: bullet reference must be stable');
    else pass('removed-blocklist kw filtered out; bullet reference stable');
}

// ─── 5. Dedup within one proposal ───────────────────────────────────────────
{
    const original = mkBullet('b1', 'Built a Python API');
    const flat: FlatBullet[] = [mkFlat('work-role', 'wr_1', original)];
    const proposals: AutoTagProposal[] = [
        { bulletId: 'b1', addedTags: ['Python', 'Python', 'Python'] },
    ];
    const { merged, tagsAdded, bulletsAffected } = mergeAutoTagProposals(flat, proposals);
    if (tagsAdded !== 1) fail('dedup: tagsAdded must be 1 (one effective add)', tagsAdded);
    else if (bulletsAffected !== 1) fail('dedup: bulletsAffected must be 1', bulletsAffected);
    else if (merged[0].bullet.tags.filter(t => t === 'Python').length !== 1) fail('dedup: tags must contain Python exactly once', merged[0].bullet.tags);
    else if (merged[0].bullet.autoTags.filter(t => t === 'Python').length !== 1) fail('dedup: autoTags must contain Python exactly once', merged[0].bullet.autoTags);
    else pass('duplicate kws inside one proposal collapse to one tag');
}

// ─── 5b. Case-insensitive dedup — existing lowercase vs titlecase proposal ──
// Regression for the case-sensitivity bug: a bullet with the user-typed
// lowercase "python" tag should NOT also get the titlecase "Python" appended
// when `bullet-tags-from-posting` proposes it from posting keywords.
{
    const original = mkBullet('b1', 'Built a Python API', { tags: ['python'] });
    const flat: FlatBullet[] = [mkFlat('work-role', 'wr_1', original)];
    const proposals: AutoTagProposal[] = [
        { bulletId: 'b1', addedTags: ['Python'] },
    ];
    const { merged, tagsAdded, bulletsAffected } = mergeAutoTagProposals(flat, proposals);
    if (tagsAdded !== 0) fail('case-insensitive tags: tagsAdded must be 0', tagsAdded);
    else if (bulletsAffected !== 0) fail('case-insensitive tags: bulletsAffected must be 0', bulletsAffected);
    else if (merged[0].bullet.tags.length !== 1) fail('case-insensitive tags: must remain a single tag', merged[0].bullet.tags);
    else if (merged[0].bullet.tags[0] !== 'python') fail('case-insensitive tags: existing casing preserved', merged[0].bullet.tags);
    else if (merged[0].bullet !== original) fail('case-insensitive tags: bullet reference must be stable when no effective change');
    else pass('case-insensitive dedup: lowercase tag blocks titlecase proposal, existing casing kept');
}

// ─── 5c. Case-insensitive removedTags blocklist ─────────────────────────────
// Regression: removed "python" (lowercase) must block proposed "Python".
{
    const original = mkBullet('b1', 'Built a Python API', { removedTags: ['python'] });
    const flat: FlatBullet[] = [mkFlat('work-role', 'wr_1', original)];
    const proposals: AutoTagProposal[] = [
        { bulletId: 'b1', addedTags: ['Python'] },
    ];
    const { merged, tagsAdded, bulletsAffected } = mergeAutoTagProposals(flat, proposals);
    if (tagsAdded !== 0) fail('case-insensitive removedTags: tagsAdded must be 0', tagsAdded);
    else if (bulletsAffected !== 0) fail('case-insensitive removedTags: bulletsAffected must be 0', bulletsAffected);
    else if (merged[0].bullet.tags.includes('Python')) fail('case-insensitive removedTags: must NOT acquire blocked kw', merged[0].bullet.tags);
    else pass('case-insensitive blocklist: lowercase removedTags blocks titlecase proposal');
}

// ─── 6. Excluded bullets — flattenProfileBullets must filter them out ───────
{
    const profile = {
        workRoles: [{
            id: 'wr_1',
            bullets: [
                mkBullet('b_keep', 'Built a Python API'),
                mkBullet('b_excluded', 'Old project we never list', { excluded: true }),
            ],
        }],
        projects: [{
            id: 'pr_1',
            bullets: [
                mkBullet('b_proj_keep', 'Shipped a Go service'),
                mkBullet('b_proj_excluded', 'Abandoned side project', { excluded: true }),
            ],
        }],
        education: [{
            id: 'ed_1',
            bullets: [
                mkBullet('b_edu_keep', 'GPA 3.8'),
                mkBullet('b_edu_excluded', 'Course we hated', { excluded: true }),
            ],
        }],
    };
    const flat = flattenProfileBullets(profile);
    const ids = flat.map(f => f.bullet.id).sort();
    const expected = ['b_edu_keep', 'b_keep', 'b_proj_keep'].sort();
    const match = ids.length === expected.length && ids.every((id, i) => id === expected[i]);
    if (!match) fail('flatten: excluded bullets must be filtered out', { got: ids, expected });
    else pass('flattenProfileBullets drops excluded bullets across all three kinds');
}

// Defensive merge call WITH an excluded bullet passed through anyway. The
// caller's contract says it pre-filters, but the merge step must remain
// well-defined: matching id → apply the merge per the same rules; no special
// excluded-bullet handling.
{
    const flat: FlatBullet[] = [
        mkFlat('work-role', 'wr_1', mkBullet('b1', 'Built a Python API', { excluded: true })),
    ];
    const proposals: AutoTagProposal[] = [
        { bulletId: 'b1', addedTags: ['Python'] },
    ];
    const { merged, tagsAdded } = mergeAutoTagProposals(flat, proposals);
    // mergeAutoTagProposals is contract-neutral on excluded — it processes
    // whatever the caller hands in. The orchestrator's job is to pre-filter.
    // Document the behavior so a future refactor doesn't silently change it.
    if (tagsAdded !== 1) fail('excluded-but-passed-through: merge applies (caller owns pre-filter)', tagsAdded);
    else if (!merged[0].bullet.tags.includes('Python')) fail('excluded-but-passed-through: tags must include Python');
    else pass('merge treats excluded bullets like any other (caller filters upstream)');
}

// ─── 7. Unknown bulletId in proposal — silently dropped ─────────────────────
{
    const original = mkBullet('b1', 'Built a Python API');
    const flat: FlatBullet[] = [mkFlat('work-role', 'wr_1', original)];
    const proposals: AutoTagProposal[] = [
        { bulletId: 'b_unknown_id', addedTags: ['Python'] },
    ];
    const { merged, tagsAdded, bulletsAffected } = mergeAutoTagProposals(flat, proposals);
    if (tagsAdded !== 0) fail('unknown-id: tagsAdded must be 0', tagsAdded);
    else if (bulletsAffected !== 0) fail('unknown-id: bulletsAffected must be 0', bulletsAffected);
    else if (merged[0].bullet !== original) fail('unknown-id: bullet reference must be stable');
    else pass('unknown bulletId silently dropped, no throw');
}

// ─── 8. Reference stability across mixed proposals ──────────────────────────
{
    const b1 = mkBullet('b1', 'Built a Python API'); // will be modified
    const b2 = mkBullet('b2', 'Wrote Go services');  // will NOT be modified
    const b3 = mkBullet('b3', 'Shipped a Rust CLI', { tags: ['Rust'] }); // proposal will be filtered
    const flat: FlatBullet[] = [
        mkFlat('work-role', 'wr_1', b1),
        mkFlat('work-role', 'wr_1', b2),
        mkFlat('project', 'pr_1', b3),
    ];
    const proposals: AutoTagProposal[] = [
        { bulletId: 'b1', addedTags: ['Python'] },
        { bulletId: 'b3', addedTags: ['Rust'] }, // already in tags — filtered
    ];
    const { merged, tagsAdded, bulletsAffected } = mergeAutoTagProposals(flat, proposals);
    if (tagsAdded !== 1) fail('mixed: tagsAdded must be 1', tagsAdded);
    else if (bulletsAffected !== 1) fail('mixed: bulletsAffected must be 1', bulletsAffected);
    else if (merged[0].bullet === b1) fail('mixed: modified bullet b1 must have a new ref');
    else if (merged[1].bullet !== b2) fail('mixed: unchanged bullet b2 must keep its ref');
    else if (merged[2].bullet !== b3) fail('mixed: bullet b3 (proposal filtered) must keep its ref');
    else pass('reference stability: only modified bullets get new refs');
}

// ─── 9. New autoTags are deduped against pre-existing autoTags ──────────────
// Edge case for the second-generate path: a bullet was already auto-tagged
// on a previous generate (so kw lives in BOTH tags + autoTags). On a second
// generate the post-filter drops it from `tags` (rule: already in tags), so
// it shouldn't be appended to autoTags again either. Same merge step — but
// the autoTags-dedup logic should hold up if the upstream filter is ever
// loosened, so test it independently with a synthetic "kw already in
// autoTags, not in tags" config.
{
    const original = mkBullet('b1', 'Built a Python API', { autoTags: ['Python'] });
    const flat: FlatBullet[] = [mkFlat('work-role', 'wr_1', original)];
    const proposals: AutoTagProposal[] = [
        { bulletId: 'b1', addedTags: ['Python'] },
    ];
    const { merged, tagsAdded, bulletsAffected } = mergeAutoTagProposals(flat, proposals);
    // tags didn't have Python yet, so the post-filter doesn't drop it.
    // It gets added to tags + autoTags. autoTags-dedup ensures only one copy.
    if (tagsAdded !== 1) fail('autoTags-dedup: tagsAdded should be 1', tagsAdded);
    else if (bulletsAffected !== 1) fail('autoTags-dedup: bulletsAffected should be 1', bulletsAffected);
    else if (merged[0].bullet.autoTags.filter(t => t === 'Python').length !== 1) fail('autoTags-dedup: Python should appear exactly once in autoTags', merged[0].bullet.autoTags);
    else pass('autoTags array deduped against pre-existing entries');
}

console.log(`\n${passes}/${passes + fails} steps passed`);
if (fails > 0) process.exit(1);
console.log('All checks passed.');
