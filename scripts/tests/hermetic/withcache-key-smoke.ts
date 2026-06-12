/**
 * Hermetic smoke for the two P5.5 lib/cache.ts fixes (2026-06-12):
 *
 *   (a) Cache-key query normalization — the key is "pathname + sorted query"
 *       (params.sort() after the ?v= cache-buster strip), so '?a=1&b=2' and
 *       '?b=2&a=1' collapse to ONE entry instead of forking the key.
 *
 *   (b) Wired ignore-expiry stale fallback — serveStale used to depend on the
 *       EXPIRED L1 entry still being in the map, but pruneExpiredL1 sweeps
 *       expired entries 5-minutely and l2Read refuses expired rows, so the
 *       fallback mostly couldn't fire. withCache now falls back to
 *       readCachedDataIgnoringExpiry (L2 row regardless of expiry) when the
 *       in-map stale entry is gone, keeping the 60s retry-TTL re-cache.
 *
 * Genuinely hermetic: no server, no network, no PM2, and the L2 backend is a
 * THROWAWAY SQLite file in /tmp (DATABASE_URL pinned before any import; the
 * CacheEntry table is created with raw DDL matching prisma/schema.prisma) —
 * dev.db / prod.db are never touched.
 */
process.env.CACHE_BACKEND = "sqlite";
const TMP_DB = `/tmp/withcache-key-smoke-${process.pid}-${Date.now()}.db`;
process.env.DATABASE_URL = `file:${TMP_DB}`;
// @types/node marks NODE_ENV as readonly; cast through Record so we can
// guarantee a value. development ⇒ the L1 map is reachable via globalThis
// (the seam we use to simulate the 5-min pruner).
(process.env as Record<string, string | undefined>).NODE_ENV =
    process.env.NODE_ENV ?? "development";

import { unlinkSync } from "node:fs";

let passes = 0;
let fails = 0;
function pass(msg: string) { console.log(`[PASS] ${msg}`); passes++; }
function fail(msg: string, detail?: unknown) { console.error(`[FAIL] ${msg}`, detail ?? ""); fails++; }

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function main() {
    // Dynamic imports: env (DATABASE_URL, CACHE_BACKEND) must be in effect
    // before lib/prisma.ts / lib/cache.ts capture it at module load.
    const { prisma } = await import("@/lib/prisma");
    await prisma.$executeRawUnsafe(
        `CREATE TABLE IF NOT EXISTS "CacheEntry" (
            "key"       TEXT NOT NULL PRIMARY KEY,
            "data"      TEXT NOT NULL,
            "expiry"    DATETIME NOT NULL,
            "updatedAt" DATETIME NOT NULL
        )`,
    );
    const { withCache } = await import("@/lib/cache");
    const { NextResponse } = await import("next/server");

    const l1Map = (globalThis as any).apiCache as Map<string, unknown>;
    if (!(l1Map instanceof Map)) throw new Error("L1 map not reachable on globalThis — NODE_ENV seam changed?");

    try {
        // ---- (a) sorted-query cache key -----------------------------------
        {
            let calls = 0;
            const handler = withCache(async () => {
                calls++;
                return NextResponse.json({ n: calls });
            }, 60);

            const r1 = await handler(new Request("http://localhost/api/key-norm?b=2&a=1"));
            const r2 = await handler(new Request("http://localhost/api/key-norm?a=1&b=2"));
            if (r1.headers.get("X-Cache") !== "MISS") fail(`sorted key: first call should MISS, got ${r1.headers.get("X-Cache")}`);
            else if (r2.headers.get("X-Cache") !== "HIT") fail(`sorted key: reordered params should HIT, got ${r2.headers.get("X-Cache")}`);
            else if (calls !== 1) fail(`sorted key: handler ran ${calls} times (expected 1)`);
            else pass("param reorder collapses to one sorted-query key");

            // The ?v= buster strips BEFORE sorting: refresh forces the handler,
            // then the repopulated entry serves the sorted key again.
            const r3 = await handler(new Request("http://localhost/api/key-norm?v=9&b=2&a=1"));
            const r4 = await handler(new Request("http://localhost/api/key-norm?a=1&b=2"));
            if (r3.headers.get("X-Cache") !== "MISS") fail(`sorted key: ?v= refresh should MISS, got ${r3.headers.get("X-Cache")}`);
            else if (r4.headers.get("X-Cache") !== "HIT" || calls !== 2) fail(`sorted key: post-refresh should HIT the sorted key (calls=${calls})`);
            else pass("?v= strips before sort — refresh repopulates the same sorted key");

            const sortedKey = "/api/key-norm?a=1&b=2";
            if (l1Map.has(sortedKey)) pass("L1 key is the sorted form (pathname + sorted query)");
            else fail(`L1 key mismatch — expected "${sortedKey}" in L1 map`, Array.from(l1Map.keys()));
        }

        // ---- (b1) handler throws, L1 stale entry PRUNED, L2 row expired ----
        {
            let mode: "ok" | "throw" = "ok";
            const handler = withCache(async () => {
                if (mode === "throw") throw new Error("simulated upstream failure");
                return NextResponse.json({ value: "good" });
            }, 1); // 1s TTL so it expires fast

            const KEY = "/api/stale-l2-throw";
            await handler(new Request(`http://localhost${KEY}`)); // populate L1 + L2
            await sleep(1200); // expire both
            l1Map.delete(KEY); // simulate pruneExpiredL1's 5-min sweep
            if (l1Map.has(KEY)) fail("setup: L1 entry should be gone after simulated prune");

            mode = "throw";
            const r = await handler(new Request(`http://localhost${KEY}`));
            if (r.headers.get("X-Cache") !== "STALE-FALLBACK") fail(`L2 fallback: expected STALE-FALLBACK, got ${r.headers.get("X-Cache")}`);
            else if ((await r.clone().json()).value !== "good") fail("L2 fallback: should serve the last good payload");
            else pass("throw + pruned L1 + expired L2 row → STALE-FALLBACK via readCachedDataIgnoringExpiry");

            // 60s retry-TTL semantics: the fallback re-cached the payload, so
            // the next call HITs without invoking the (still-broken) handler.
            const r2 = await handler(new Request(`http://localhost${KEY}`));
            if (r2.headers.get("X-Cache") !== "HIT") fail(`retry TTL: expected HIT off the 60s re-cache, got ${r2.headers.get("X-Cache")}`);
            else if ((await r2.clone().json()).value !== "good") fail("retry TTL: re-cached payload should be the last good one");
            else pass("fallback re-caches with the 60s retry TTL (next call HITs)");
        }

        // ---- (b2) non-OK response, L1 stale entry PRUNED -------------------
        {
            let mode: "ok" | "fail" = "ok";
            const handler = withCache(async () => {
                if (mode === "fail") return NextResponse.json({ err: "upstream 502" }, { status: 502 });
                return NextResponse.json({ value: "good" });
            }, 1);

            const KEY = "/api/stale-l2-nonok";
            await handler(new Request(`http://localhost${KEY}`));
            await sleep(1200);
            l1Map.delete(KEY);

            mode = "fail";
            const r = await handler(new Request(`http://localhost${KEY}`));
            if (r.headers.get("X-Cache") !== "STALE-FALLBACK") fail(`non-OK L2 fallback: expected STALE-FALLBACK, got ${r.headers.get("X-Cache")}`);
            else if ((await r.clone().json()).value !== "good") fail("non-OK L2 fallback: should serve the last good payload");
            else pass("non-OK + pruned L1 + expired L2 row → STALE-FALLBACK");
        }

        // ---- (b3) cold failure (no entry anywhere) still propagates --------
        {
            const handler = withCache(async () => {
                throw new Error("cold failure");
            }, 60);
            let threw = false;
            try {
                await handler(new Request("http://localhost/api/stale-l2-cold"));
            } catch (e) {
                threw = (e as Error).message === "cold failure";
            }
            if (threw) pass("cold failure with no cached payload anywhere still propagates");
            else fail("cold failure: expected the error to propagate (fallback fabricated data?)");
        }
    } finally {
        try { await prisma.$disconnect(); } catch { /* best-effort */ }
        for (const suffix of ["", "-journal", "-wal", "-shm"]) {
            try { unlinkSync(TMP_DB + suffix); } catch { /* may not exist */ }
        }
    }

    console.log(`\n${passes}/${passes + fails} steps passed`);
    if (fails > 0) process.exit(1);
    console.log("All checks passed.");
    process.exit(0);
}

main().catch((e) => {
    console.error("smoke crashed:", e);
    process.exit(1);
});
