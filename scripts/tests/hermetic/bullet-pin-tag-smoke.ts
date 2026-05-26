/**
 * Hermetic smoke for M7.7.1 — pinnedTags schema invariants.
 *
 *   npx tsx scripts/tests/hermetic/bullet-pin-tag-smoke.ts
 *
 * Pure schema test — no DB, no HTTP, no LLM. Exercises the .refine() blocks
 * on BulletWriteSchema (lib/schemas/profile.ts) that enforce the M7.7.1
 * invariants:
 *   - pinnedTags ⊆ tags (can't pin a tag that isn't applied)
 *   - pinnedTags ∩ removedTags = ∅ (blocklist wins)
 *   - existing tags ∩ removedTags = ∅ (M8.5.6, regression-pin)
 *
 * Plus the .transform() that clears autoTags on every accepted write
 * (M8.5.6 Decision 6.3 implicit-accept-on-save).
 *
 * Cross-references: the UI side (`components/ui/BulletRow.tsx:removeTag`
 * and `togglePin`) maintains the same invariants by patching neighboring
 * arrays at the source when one changes. The schema is the server-side
 * truth — hand-rolled curl payloads or buggy clients can't slip through.
 */

import { BulletWriteSchema } from '@/lib/schemas/profile';

let passes = 0;
let fails = 0;
function pass(msg: string): void { console.log(`[PASS] ${msg}`); passes++; }
function fail(msg: string, detail?: unknown): void {
    console.error(`[FAIL] ${msg}`, detail ?? '');
    fails++;
}

function expectReject(label: string, payload: unknown, expectedMessageFragment: string): void {
    const r = BulletWriteSchema.safeParse(payload);
    if (r.success) {
        fail(`${label} — should have rejected but parsed cleanly`, r.data);
        return;
    }
    const messages = r.error.issues.map(i => i.message).join('; ');
    if (!messages.toLowerCase().includes(expectedMessageFragment.toLowerCase())) {
        fail(`${label} — rejected but error message didn't mention "${expectedMessageFragment}"`, messages);
        return;
    }
    pass(`${label} — rejected with expected error`);
}

function expectAccept(label: string, payload: unknown): unknown {
    const r = BulletWriteSchema.safeParse(payload);
    if (!r.success) {
        fail(`${label} — should have parsed cleanly`, r.error.issues);
        return null;
    }
    pass(`${label} — accepted`);
    return r.data;
}

// ─── 1. Happy path: tags + pinnedTags consistent + no overlap with removedTags ─
{
    expectAccept('valid bullet with one pinned tag', {
        id: 'b1',
        text: 'Built a Python API',
        tags: ['Python', 'API'],
        autoTags: [],
        removedTags: ['Ruby'],
        pinnedTags: ['Python'],
        locked: false,
        excluded: false,
    });
}

// ─── 2. pinnedTags references a tag not in tags → reject ───────────────────
{
    expectReject(
        'pinned tag missing from tags',
        {
            id: 'b1',
            text: 'Built a Python API',
            tags: ['Python'],
            pinnedTags: ['Python', 'GhostTag'],
            removedTags: [],
        },
        'pinnedTags',
    );
}

// ─── 3. pinnedTags ∩ removedTags ≠ ∅ → reject ──────────────────────────────
{
    expectReject(
        'tag in both pinnedTags and removedTags',
        {
            id: 'b1',
            text: 'Built a Python API',
            tags: ['Python'],
            pinnedTags: ['Python'],
            removedTags: ['Python'],
        },
        'pinnedTags',
    );
}

// ─── 4. Existing M8.5.6 invariant: tags ∩ removedTags = ∅ → reject ─────────
// Regression-pin so the M7.7.1 .refine() additions didn't break this earlier
// guard.
{
    expectReject(
        'tag in both tags and removedTags',
        {
            id: 'b1',
            text: 'Built a Python API',
            tags: ['Python'],
            removedTags: ['Python'],
        },
        'tags',
    );
}

// ─── 5. Empty arrays vacuously satisfy invariants ──────────────────────────
{
    expectAccept('all arrays empty', {
        id: 'b1',
        text: 'Built a Python API',
        tags: [],
        autoTags: [],
        removedTags: [],
        pinnedTags: [],
    });
}

// ─── 6. Omitting pinnedTags is fine (invariant vacuously true) ─────────────
{
    expectAccept('no pinnedTags field at all', {
        id: 'b1',
        text: 'Built a Python API',
        tags: ['Python'],
        removedTags: ['JavaScript'],
    });
}

// ─── 7. autoTags cleared on successful parse (Decision 6.3) ────────────────
{
    const parsed = expectAccept('autoTags cleared on transform', {
        id: 'b1',
        text: 'Built a Python API',
        tags: ['Python'],
        autoTags: ['Python'],
        removedTags: [],
        pinnedTags: [],
    }) as { autoTags: string[] } | null;
    if (parsed) {
        if (parsed.autoTags.length !== 0) {
            fail('autoTags should be cleared by .transform()', parsed.autoTags);
        } else {
            pass('autoTags cleared by .transform() (Decision 6.3 implicit-accept)');
        }
    }
}

// ─── 8. Multiple pins + auto-set + removed all in one write ────────────────
// Real-world shape from BulletRow after a tag-suggest accept + a couple of
// pin toggles + a manual chip-X. Verify the full payload parses.
{
    expectAccept('realistic multi-state payload', {
        id: 'b1',
        text: 'Built a distributed Python + Postgres system',
        tags: ['Python', 'Postgres', 'distributed-systems'],
        autoTags: ['distributed-systems'],
        removedTags: ['JavaScript'],
        pinnedTags: ['Python', 'Postgres'],
        locked: false,
        excluded: false,
    });
}

console.log(`\n${passes}/${passes + fails} steps passed`);
if (fails > 0) process.exit(1);
console.log('All checks passed.');
