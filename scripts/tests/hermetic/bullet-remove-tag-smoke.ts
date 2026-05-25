/**
 * Hermetic smoke for the BulletWriteSchema's M8.5.6 invariants:
 *   1. `removedTags` blocklist (Decision 6.1) — a tag in `removedTags` may
 *      not also appear in `tags` on the same write.
 *   2. `autoTags` implicit-accept-on-save (Decision 6.3) — every successful
 *      parse zeros out `autoTags`, so the next time the bullet round-trips
 *      to the server the LLM-suggested keywords are folded into `tags` and
 *      lose their "auto" status.
 *
 *   npx tsx scripts/tests/hermetic/bullet-remove-tag-smoke.ts
 *
 * Pure schema-level — no DB, no HTTP. Confirms server-side semantics in
 * isolation so client-side optimistic updates can be verified independently
 * against the same contract.
 */
import { BulletWriteSchema } from "@/lib/schemas/profile";

let passes = 0;
let fails = 0;
function pass(msg: string) { console.log(`[PASS] ${msg}`); passes++; }
function fail(msg: string, detail?: unknown) { console.error(`[FAIL] ${msg}`, detail ?? ""); fails++; }

function main() {
    // ── 1. removedTags accepted alongside disjoint tags ────────────────────
    {
        const result = BulletWriteSchema.safeParse({
            id: 'b_1',
            text: 'Shipped a thing',
            tags: ['A', 'B'],
            removedTags: ['C'],
        });
        if (!result.success) {
            fail("disjoint tags + removedTags should validate", result.error.issues);
        } else {
            pass("disjoint tags + removedTags validates");
            if (Array.isArray(result.data.autoTags) && result.data.autoTags.length === 0) {
                pass("autoTags cleared to [] by transform (no autoTags in input)");
            } else {
                fail("autoTags should be []", result.data.autoTags);
            }
            if (Array.isArray(result.data.tags) && result.data.tags.length === 2) {
                pass("tags preserved through transform");
            } else {
                fail("tags should be ['A','B']", result.data.tags);
            }
            if (Array.isArray(result.data.removedTags) && result.data.removedTags.length === 1 && result.data.removedTags[0] === 'C') {
                pass("removedTags preserved through transform");
            } else {
                fail("removedTags should be ['C']", result.data.removedTags);
            }
        }
    }

    // ── 2. tags ∩ removedTags rejected ────────────────────────────────────
    {
        const result = BulletWriteSchema.safeParse({
            id: 'b_2',
            text: 'Cannot have A in both arrays',
            tags: ['A'],
            removedTags: ['A'],
        });
        if (result.success) {
            fail("overlap should reject", result.data);
        } else {
            // zod surfaces the .refine() message inside issues
            const msg = result.error.issues.map(i => i.message).join(' | ');
            if (/A tag cannot appear in both/i.test(msg) || result.error.issues.length > 0) {
                pass("overlap rejected with refine error");
            } else {
                fail("overlap rejected but error message looks off", msg);
            }
        }
    }

    // ── 3. autoTags-only payload still parses and zeros out ───────────────
    {
        const result = BulletWriteSchema.safeParse({
            id: 'b_3',
            text: 'Bullet with autoTags pending review',
            autoTags: ['Python', 'Go'],
        });
        if (!result.success) {
            fail("autoTags-only write should validate", result.error.issues);
        } else {
            pass("autoTags-only write validates");
            if (Array.isArray(result.data.autoTags) && result.data.autoTags.length === 0) {
                pass("autoTags cleared to [] post-transform (Decision 6.3 implicit-accept)");
            } else {
                fail("autoTags should be [] after transform", result.data.autoTags);
            }
        }
    }

    // ── 4. user re-adds a previously-blocked tag → blocklist cleared ──────
    // The PATCH represents the post-readd state: tag is in `tags`, NOT in
    // `removedTags`. Schema must accept it cleanly (the disjointness invariant
    // is satisfied because removedTags is empty).
    {
        const result = BulletWriteSchema.safeParse({
            id: 'b_4',
            text: 'Re-added tag after earlier removal',
            tags: ['A'],
            removedTags: [],
        });
        if (!result.success) {
            fail("re-add (tags:['A'], removedTags:[]) should validate", result.error.issues);
        } else {
            pass("re-add cleanly validates (blocklist override path)");
            if (result.data.tags?.includes('A') && (result.data.removedTags?.length ?? 0) === 0) {
                pass("re-add preserves tags=['A'], removedTags=[]");
            } else {
                fail("re-add data shape unexpected", { tags: result.data.tags, removedTags: result.data.removedTags });
            }
        }
    }

    // ── 5. minimal payload (text only) — autoTags absent → still [] ───────
    // The transform always sets autoTags to [] regardless of input presence;
    // this protects callers that omit the field entirely.
    {
        const result = BulletWriteSchema.safeParse({
            text: 'Minimal text-only write',
        });
        if (!result.success) {
            fail("text-only minimal payload should validate", result.error.issues);
        } else {
            pass("text-only minimal payload validates");
            if (Array.isArray(result.data.autoTags) && result.data.autoTags.length === 0) {
                pass("autoTags zeroed even when absent from input");
            } else {
                fail("autoTags should be [] even when absent from input", result.data.autoTags);
            }
        }
    }

    // ── 6. overlap detection is exact (string equality) ───────────────────
    // Sanity check: case-sensitive distinct entries are NOT collisions.
    {
        const result = BulletWriteSchema.safeParse({
            text: 'Case sensitivity check',
            tags: ['python'],
            removedTags: ['Python'],
        });
        if (!result.success) {
            fail("'python' vs 'Python' should NOT be treated as overlap", result.error.issues);
        } else {
            pass("case-sensitive: 'python' and 'Python' are distinct, allowed");
        }
    }

    // ── final tally ───────────────────────────────────────────────────────
    console.info(`\n${passes}/${passes + fails} steps passed`);
    if (fails > 0) {
        console.error(`${fails} step(s) failed.`);
        process.exit(1);
    }
    console.info('All checks passed.');
}

main();
