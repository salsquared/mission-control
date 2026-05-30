/**
 * Hermetic smoke for the cross-tier LLM dedup cache (docs/archive/cross-tier-llm-dedup.html).
 *
 * Fully hermetic: no real Gemini (a fake `compute` increments a counter), no
 * PM2, no network, and it uses its OWN temp LLM_CACHE_PATH — never touches
 * dev.db/prod.db or the real data/llm-cache.db. Cleans up after itself.
 *
 * Scenarios (the doc §8 checklist):
 *   1. Single-flight — N concurrent callers of the same key ⇒ exactly ONE
 *      compute; all callers get the same result.
 *   2. Leader error not cached — a throwing compute releases the row so the
 *      next caller re-leads (compute runs again).
 *   3. Stale-leader takeover — a `pending` row older than the lease is stolen
 *      and recomputed by a fresh caller.
 *   4. Cache-down degradation — an unwritable LLM_CACHE_PATH disables the store;
 *      calls still succeed via direct compute.
 *   5. Prune — old `pending` (crashed leader) is swept; recent `done` survives.
 *   + cacheKey determinism (pure, no DB).
 */
import { unlinkSync } from "node:fs";
import { z } from "zod";

let passed = 0;
let failed = 0;
function check(name: string, condition: boolean, detail?: string) {
    if (condition) {
        console.log(`[PASS] ${name}`);
        passed++;
    } else {
        console.error(`[FAIL] ${name}${detail ? ` — ${detail}` : ""}`);
        failed++;
    }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const FAST = { pollMs: 15, maxWaitMs: 3000, leaseMs: 30_000 } as const;

// A trivial schema so cacheKey has something to fingerprint.
const SCHEMA = z.object({ v: z.number() });

const TMP_DB = `/tmp/llm-cache-smoke-${process.pid}-${Date.now()}.db`;

async function main() {
    // Point the store at a throwaway file BEFORE the first store touch.
    process.env.LLM_CACHE_PATH = TMP_DB;

    const cache = await import("@/lib/ai/llm-cache");
    const { cacheKey, llmCached, pruneLlmCache, _resetLlmCacheForTests, _statsForTests, _seedPendingForTests } = cache;
    await _resetLlmCacheForTests(); // ensure a fresh store at TMP_DB

    try {
        // ---- cacheKey determinism (pure) ----------------------------------
        const k1 = cacheKey({ model: "m1", user: "hello", schema: SCHEMA });
        const k1b = cacheKey({ model: "m1", user: "hello", schema: SCHEMA });
        const k2 = cacheKey({ model: "m2", user: "hello", schema: SCHEMA });
        const k3 = cacheKey({ model: "m1", user: "world", schema: SCHEMA });
        check("cacheKey is deterministic for identical inputs", k1 === k1b);
        check("cacheKey changes with model", k1 !== k2);
        check("cacheKey changes with prompt", k1 !== k3);

        // ---- 1. Single-flight ---------------------------------------------
        {
            const key = cacheKey({ model: "m1", user: "single-flight", schema: SCHEMA });
            let calls = 0;
            const compute = async () => {
                calls++;
                await sleep(60); // long enough that followers must poll
                return { v: 42, lead: calls };
            };
            const results = await Promise.all(
                Array.from({ length: 20 }, () => llmCached({ key, name: "smoke", model: "m1" }, compute, FAST)),
            );
            check("single-flight: compute ran exactly once for 20 concurrent callers", calls === 1, `calls=${calls}`);
            check("single-flight: all callers got the leader's result", results.every((r) => r.v === 42 && r.lead === 1));
        }

        // ---- 2. Leader error is not cached --------------------------------
        {
            const key = cacheKey({ model: "m1", user: "error-not-cached", schema: SCHEMA });
            let calls = 0;
            let threw = false;
            try {
                await llmCached({ key, name: "smoke", model: "m1" }, async () => {
                    calls++;
                    throw new Error("boom");
                });
            } catch {
                threw = true;
            }
            check("error: the throwing call rejected (error propagated, not swallowed)", threw);
            check("error: leader computed once", calls === 1, `calls=${calls}`);

            // A second call with the same key must RE-LEAD (row was released).
            const r = await llmCached({ key, name: "smoke", model: "m1" }, async () => {
                calls++;
                return { v: 7 };
            });
            check("error: second call re-leads (error was NOT cached)", calls === 2, `calls=${calls}`);
            check("error: second call returns the fresh result", r.v === 7);
        }

        // ---- 3. Stale-leader takeover -------------------------------------
        {
            const key = cacheKey({ model: "m1", user: "stale-takeover", schema: SCHEMA });
            const seeded = await _seedPendingForTests(key, Date.now() - 60_000); // 60s > 30s lease
            check("stale: seeded a stale pending row", seeded);
            let calls = 0;
            const r = await llmCached(
                { key, name: "smoke", model: "m1" },
                async () => {
                    calls++;
                    return { v: 99 };
                },
                FAST,
            );
            check("stale: fresh caller stole the dead lease and computed", calls === 1, `calls=${calls}`);
            check("stale: returns the recomputed result", r.v === 99);
        }

        // ---- 5. Prune (run while the store is still healthy) --------------
        {
            // A crashed-leader pending row, well past the 24h pending retention.
            await _seedPendingForTests("prune-old-pending", Date.now() - 48 * 60 * 60 * 1000);
            // A fresh done row (just computed above in scenarios 1-3 + this one).
            const doneKey = cacheKey({ model: "m1", user: "prune-keep-done", schema: SCHEMA });
            await llmCached({ key: doneKey, name: "smoke", model: "m1" }, async () => ({ v: 1 }));

            const before = await _statsForTests();
            const res = await pruneLlmCache({ pendingRetentionHours: 24, doneRetentionDays: 60 });
            const after = await _statsForTests();

            check("prune: store reported healthy (not disabled)", res.disabled === false);
            check("prune: deleted exactly the stale pending row", res.deleted === 1, `deleted=${res.deleted}`);
            check("prune: no pending rows remain", (after?.pending ?? -1) === 0, `pending=${after?.pending}`);
            check(
                "prune: recent done rows survived default retention",
                !!before && !!after && after.done === before.done,
                `before.done=${before?.done} after.done=${after?.done}`,
            );
        }

        // ---- 4. Cache-down degradation (LAST — switches to an unwritable path)
        {
            process.env.LLM_CACHE_PATH = `/nonexistent-llm-cache-dir-${process.pid}/cache.db`;
            await _resetLlmCacheForTests(); // re-init against the bad path → disabled
            let calls = 0;
            const r = await llmCached({ key: "cache-down", name: "smoke", model: "m1" }, async () => {
                calls++;
                return { v: 5 };
            });
            check("cache-down: call still succeeded via direct compute", r.v === 5 && calls === 1, `calls=${calls}`);
            const stats = await _statsForTests();
            check("cache-down: store reports disabled (stats null)", stats === null);
        }

        await _resetLlmCacheForTests();
    } finally {
        // Clean up the temp DB + WAL/shm sidecars.
        for (const suffix of ["", "-wal", "-shm"]) {
            try {
                unlinkSync(TMP_DB + suffix);
            } catch {
                /* may not exist */
            }
        }
    }

    console.log(`\n${passed}/${passed + failed} steps passed`);
    if (failed > 0) process.exit(1);
}

main().catch((e) => {
    console.error("smoke crashed:", e);
    process.exit(1);
});
