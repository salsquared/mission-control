/**
 * Hermetic smoke for the shared cross-tier cache base (lib/shared-sqlite-cache.ts)
 * — the engine behind lib/research/shared-cache.ts (docs/archive/arxiv-rate-limit-fix.html
 * Layer 1). Also the regression net for the base that lib/ai/llm-cache.ts is
 * refactored onto (OQ8).
 *
 * Fully hermetic: no network, no PM2, no Prisma. Uses its OWN temp DB file and
 * cleans up. Simulates the two tiers (dev + prod) with TWO createSharedCache
 * instances pointed at the SAME file.
 *
 * Scenarios:
 *   1. Cross-tier read-across — tier B reads tier A's done row, no recompute.
 *   2. Cross-tier single-flight — concurrent A+B miss ⇒ exactly ONE compute.
 *   3. TTL expiry — an expired `done` row is re-led (recomputed).
 *   4. force — the cache-buster path drops the row and recomputes.
 *   5. Error not cached — a throwing compute releases the row; next call re-leads.
 *   6. Cache-down degradation — an unwritable path disables the store; compute
 *      still runs (uncached), stats() is null.
 */
import { unlinkSync } from "node:fs";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string) {
    if (cond) {
        console.log(`[PASS] ${name}`);
        passed++;
    } else {
        console.error(`[FAIL] ${name}${detail ? ` — ${detail}` : ""}`);
        failed++;
    }
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const FAST = { pollMs: 15, maxWaitMs: 3000, leaseMs: 30_000 } as const;

const TMP = `/tmp/research-cache-smoke-${process.pid}-${Date.now()}.db`;

async function main() {
    const { createSharedCache } = await import("@/lib/shared-sqlite-cache");

    // Two instances on ONE file = the two tiers.
    const tierA = createSharedCache({ resolvePath: () => TMP, table: "research_cache", label: "smokeA" });
    const tierB = createSharedCache({ resolvePath: () => TMP, table: "research_cache", label: "smokeB" });

    try {
        // ---- 1. Cross-tier read-across -----------------------------------
        {
            let aCalls = 0;
            let bCalls = 0;
            const va = await tierA.getOrCompute("k1", async () => { aCalls++; return { paper: "X", n: 1 }; }, { ttlSeconds: 100 });
            const vb = await tierB.getOrCompute("k1", async () => { bCalls++; return { paper: "OTHER", n: 2 }; }, { ttlSeconds: 100 });
            check("read-across: tier A computed once", aCalls === 1, `aCalls=${aCalls}`);
            check("read-across: tier B did NOT recompute (read A's row)", bCalls === 0, `bCalls=${bCalls}`);
            check("read-across: tier B got tier A's value", (vb as any).paper === "X" && (va as any).paper === "X");
        }

        // ---- 2. Cross-tier single-flight ---------------------------------
        {
            let calls = 0;
            const compute = async () => { calls++; await sleep(60); return { v: 42 }; };
            const results = await Promise.all([
                ...Array.from({ length: 6 }, () => tierA.getOrCompute("k2", compute, { ttlSeconds: 100, ...FAST })),
                ...Array.from({ length: 6 }, () => tierB.getOrCompute("k2", compute, { ttlSeconds: 100, ...FAST })),
            ]);
            check("single-flight: exactly ONE compute across both tiers", calls === 1, `calls=${calls}`);
            check("single-flight: all 12 callers got the result", results.every((r) => (r as any).v === 42));
        }

        // ---- 3. TTL expiry ------------------------------------------------
        {
            let calls = 0;
            const compute = async () => { calls++; return { v: calls }; };
            const first = await tierA.getOrCompute("k3", compute, { ttlSeconds: 0.05 }); // 50ms TTL
            await sleep(90);
            const second = await tierA.getOrCompute("k3", compute, { ttlSeconds: 0.05, ...FAST });
            check("expiry: expired done row was recomputed", calls === 2, `calls=${calls}`);
            check("expiry: returns the fresh value after expiry", (first as any).v === 1 && (second as any).v === 2);
        }

        // ---- 4. force (cache-buster) -------------------------------------
        {
            let calls = 0;
            const compute = async () => { calls++; return { v: calls }; };
            await tierA.getOrCompute("k4", compute, { ttlSeconds: 100 });
            const forced = await tierA.getOrCompute("k4", compute, { ttlSeconds: 100, force: true });
            check("force: recomputed despite a fresh row", calls === 2, `calls=${calls}`);
            check("force: returns the recomputed value", (forced as any).v === 2);
        }

        // ---- 5. Error is not cached --------------------------------------
        {
            let calls = 0;
            let threw = false;
            try {
                await tierA.getOrCompute("k5", async () => { calls++; throw new Error("boom"); }, { ttlSeconds: 100 });
            } catch { threw = true; }
            check("error: threw (propagated, not swallowed)", threw);
            const r = await tierA.getOrCompute("k5", async () => { calls++; return { v: 7 }; }, { ttlSeconds: 100, ...FAST });
            check("error: second call re-leads (error was NOT cached)", calls === 2, `calls=${calls}`);
            check("error: second call returns the fresh result", (r as any).v === 7);
        }

        // ---- 6. Cache-down degradation (LAST — bad path) -----------------
        {
            const broken = createSharedCache({
                resolvePath: () => `/nonexistent-research-dir-${process.pid}/cache.db`,
                table: "research_cache",
                label: "smokeBroken",
            });
            let calls = 0;
            const r = await broken.getOrCompute("cache-down", async () => { calls++; return { v: 5 }; }, { ttlSeconds: 100 });
            check("cache-down: call still succeeded via direct compute", (r as any).v === 5 && calls === 1, `calls=${calls}`);
            const stats = await broken.stats();
            check("cache-down: store reports disabled (stats null)", stats === null);
            await broken._reset();
        }
    } finally {
        await tierA._reset();
        await tierB._reset();
        for (const suffix of ["", "-wal", "-shm"]) {
            try { unlinkSync(TMP + suffix); } catch { /* may not exist */ }
        }
    }

    console.log(`\n${passed}/${passed + failed} steps passed`);
    if (failed > 0) process.exit(1);
}

main().catch((e) => {
    console.error("smoke crashed:", e);
    process.exit(1);
});
