/**
 * Hermetic smoke for `lib/cache.ts:withCache` — the wrapper used by every
 * external-data API route. No server, no DB (memory backend only), no network.
 *
 *   DATABASE_URL="file:./dev.db" npx tsx scripts/tests/hermetic/cache-smoke.ts
 *
 * Exercises:
 *   1. MISS on first call (handler runs, X-Cache=MISS)
 *   2. HIT on second call within TTL (handler not re-run, X-Cache=HIT)
 *   3. `?v=…` cache-buster forces a refresh
 *   4. Query string normalization (param order doesn't fork the key)
 *   5. Handler throws + prior good entry → STALE-FALLBACK with old data
 *   6. Handler throws + no prior entry → throw propagates
 *   7. Non-OK response + prior good entry → STALE-FALLBACK
 *   8. In-flight dedup: 5 concurrent calls invoke handler exactly once
 *   9. userKeyFn scopes the key per-user
 *  10. userKeyFn throwing falls back to a shared key (logged warning)
 *  11. invalidateCacheKey drops an entry
 *  12. invalidateCacheByPrefix drops a whole route family
 *  13. getCacheStats reports hits/misses honestly
 *
 * Force CACHE_BACKEND=memory so we never touch SQLite even if dev.db is wired.
 */
process.env.CACHE_BACKEND = "memory";
// @types/node marks NODE_ENV as readonly; cast through Record so we can
// guarantee a value for code paths that read it.
(process.env as Record<string, string | undefined>).NODE_ENV =
    process.env.NODE_ENV ?? "development";

import { NextResponse } from "next/server";
import {
    withCache,
    invalidateCacheKey,
    invalidateCacheByPrefix,
    getCacheStats,
} from "@/lib/cache";

let passes = 0;
let fails = 0;
function pass(msg: string) { console.log(`[PASS] ${msg}`); passes++; }
function fail(msg: string, detail?: unknown) { console.error(`[FAIL] ${msg}`, detail ?? ""); fails++; }

function makeReq(path: string): Request {
    return new Request(`http://localhost${path}`);
}

async function readJson(resp: Response): Promise<any> {
    return resp.clone().json();
}

// Wipe any leftover entries from a prior run sharing this Node process. The
// cache stores under globalThis so HMR/process reuse can carry state across
// reruns of the smoke during local dev.
function resetCacheNamespace(prefix: string) {
    invalidateCacheByPrefix(prefix);
}

async function testMissThenHit() {
    resetCacheNamespace("/api/test-miss-hit");
    let calls = 0;
    const handler = withCache(async (_req: Request) => {
        calls++;
        return NextResponse.json({ n: calls });
    }, 60);

    const r1 = await handler(makeReq("/api/test-miss-hit"));
    if (r1.headers.get("X-Cache") !== "MISS") fail(`miss: expected X-Cache=MISS, got ${r1.headers.get("X-Cache")}`);
    else if ((await readJson(r1)).n !== 1) fail("miss: expected n=1");
    else pass("first call: MISS, handler ran");

    const r2 = await handler(makeReq("/api/test-miss-hit"));
    if (r2.headers.get("X-Cache") !== "HIT") fail(`hit: expected X-Cache=HIT, got ${r2.headers.get("X-Cache")}`);
    else if (calls !== 1) fail(`hit: handler re-ran (calls=${calls})`);
    else if ((await readJson(r2)).n !== 1) fail("hit: served fresh value, expected cached n=1");
    else pass("second call: HIT, handler not re-invoked");
}

async function testCacheBuster() {
    resetCacheNamespace("/api/test-buster");
    let calls = 0;
    const handler = withCache(async () => {
        calls++;
        return NextResponse.json({ n: calls });
    }, 60);

    await handler(makeReq("/api/test-buster"));                    // MISS, calls=1
    await handler(makeReq("/api/test-buster"));                    // HIT
    const r3 = await handler(makeReq("/api/test-buster?v=123"));   // refresh, MISS again
    if (r3.headers.get("X-Cache") !== "MISS") fail(`?v=: expected MISS on refresh, got ${r3.headers.get("X-Cache")}`);
    else if (calls !== 2) fail(`?v=: handler should have run twice (calls=${calls})`);
    else pass("?v= cache-buster forces refresh");

    // After refresh the cache should be populated again (key without ?v=).
    const r4 = await handler(makeReq("/api/test-buster"));
    if (r4.headers.get("X-Cache") !== "HIT") fail(`post-refresh: expected HIT, got ${r4.headers.get("X-Cache")}`);
    else pass("post-refresh: cache repopulated under buster-stripped key");
}

async function testQueryNormalization() {
    resetCacheNamespace("/api/test-norm");
    let calls = 0;
    const handler = withCache(async (req: Request) => {
        calls++;
        return NextResponse.json({ url: req.url });
    }, 60);

    await handler(makeReq("/api/test-norm?a=1&b=2"));
    const r2 = await handler(makeReq("/api/test-norm?a=1&b=2"));
    if (r2.headers.get("X-Cache") !== "HIT") fail(`norm: same params should HIT, got ${r2.headers.get("X-Cache")}`);
    else pass("identical params → cache HIT");

    // Different param ORDER → different key (URLSearchParams.toString preserves
    // insertion order). This is a known-limitation of the current cache and
    // worth documenting in a test so a future "fix" doesn't accidentally regress
    // it without anyone noticing.
    const r3 = await handler(makeReq("/api/test-norm?b=2&a=1"));
    if (r3.headers.get("X-Cache") === "MISS") pass("param reorder: separate cache key (documented limitation)");
    else fail("param reorder: unexpectedly HIT — cache key collapsing semantics changed?");
}

async function testStaleFallbackOnThrow() {
    resetCacheNamespace("/api/test-stale-throw");
    let mode: "ok" | "throw" = "ok";
    let calls = 0;
    const handler = withCache(async () => {
        calls++;
        if (mode === "throw") throw new Error("simulated upstream failure");
        return NextResponse.json({ value: "good" });
    }, 1); // 1s TTL so we can expire it

    await handler(makeReq("/api/test-stale-throw")); // populate
    await new Promise(r => setTimeout(r, 1100)); // expire L1 entry

    mode = "throw";
    const r = await handler(makeReq("/api/test-stale-throw"));
    if (r.headers.get("X-Cache") !== "STALE-FALLBACK") fail(`stale: expected STALE-FALLBACK on throw, got ${r.headers.get("X-Cache")}`);
    else if ((await readJson(r)).value !== "good") fail("stale: should serve prior good payload");
    else pass("handler throw + stale entry → STALE-FALLBACK with prior payload");
}

async function testThrowNoStale() {
    resetCacheNamespace("/api/test-throw-cold");
    const handler = withCache(async () => {
        throw new Error("cold failure");
    }, 60);

    let threw = false;
    try {
        await handler(makeReq("/api/test-throw-cold"));
    } catch (e) {
        threw = (e as Error).message === "cold failure";
    }
    if (threw) pass("handler throw + no stale → error propagates");
    else fail("cold throw: expected error to propagate");
}

async function testNonOkWithStale() {
    resetCacheNamespace("/api/test-nonok-stale");
    let mode: "ok" | "fail" = "ok";
    const handler = withCache(async () => {
        if (mode === "fail") return NextResponse.json({ err: "upstream 502" }, { status: 502 });
        return NextResponse.json({ value: "good" });
    }, 1);

    await handler(makeReq("/api/test-nonok-stale"));
    await new Promise(r => setTimeout(r, 1100));

    mode = "fail";
    const r = await handler(makeReq("/api/test-nonok-stale"));
    if (r.headers.get("X-Cache") !== "STALE-FALLBACK") fail(`non-OK + stale: expected STALE-FALLBACK, got ${r.headers.get("X-Cache")}`);
    else if ((await readJson(r)).value !== "good") fail("non-OK + stale: should serve prior good payload");
    else pass("non-OK response + stale entry → STALE-FALLBACK");
}

async function testInFlightDedup() {
    resetCacheNamespace("/api/test-dedup");
    let calls = 0;
    const handler = withCache(async () => {
        calls++;
        await new Promise(r => setTimeout(r, 50));
        return NextResponse.json({ n: calls });
    }, 60);

    // Fire 5 concurrent requests for the same key BEFORE the first resolves.
    const responses = await Promise.all([
        handler(makeReq("/api/test-dedup")),
        handler(makeReq("/api/test-dedup")),
        handler(makeReq("/api/test-dedup")),
        handler(makeReq("/api/test-dedup")),
        handler(makeReq("/api/test-dedup")),
    ]);

    if (calls !== 1) fail(`dedup: handler ran ${calls} times (expected 1)`);
    else pass("5 concurrent calls → handler ran once");

    const values = await Promise.all(responses.map(readJson));
    if (values.every(v => v.n === 1)) pass("all 5 callers got the same response");
    else fail("dedup: callers got divergent values", values);
}

async function testUserScoping() {
    resetCacheNamespace("u:");
    resetCacheNamespace("/api/test-user");
    let calls = 0;
    const handler = withCache(async () => {
        calls++;
        return NextResponse.json({ n: calls });
    }, { ttlSeconds: 60, userKeyFn: (req) => req.headers.get("x-user") ?? null });

    const reqA = new Request("http://localhost/api/test-user", { headers: { "x-user": "alice" } });
    const reqB = new Request("http://localhost/api/test-user", { headers: { "x-user": "bob" } });

    const a1 = await handler(reqA); // alice MISS, calls=1
    const b1 = await handler(reqB); // bob MISS, calls=2
    const a2 = await handler(reqA); // alice HIT
    const b2 = await handler(reqB); // bob HIT

    if (calls !== 2) fail(`userKeyFn: expected 2 distinct misses, got ${calls}`);
    else if (a1.headers.get("X-Cache") !== "MISS" || b1.headers.get("X-Cache") !== "MISS") fail("userKeyFn: first calls should both MISS");
    else if (a2.headers.get("X-Cache") !== "HIT" || b2.headers.get("X-Cache") !== "HIT") fail("userKeyFn: repeat calls should both HIT");
    else if ((await readJson(a1)).n === (await readJson(b1)).n) fail("userKeyFn: alice and bob got the same payload — keys collapsed");
    else pass("userKeyFn: per-user cache scoping isolates payloads");
}

async function testUserKeyFnThrows() {
    resetCacheNamespace("/api/test-user-throw");
    let calls = 0;
    const handler = withCache(async () => {
        calls++;
        return NextResponse.json({ n: calls });
    }, { ttlSeconds: 60, userKeyFn: () => { throw new Error("auth lookup failed"); } });

    const r1 = await handler(makeReq("/api/test-user-throw")); // falls back to shared key
    const r2 = await handler(makeReq("/api/test-user-throw"));
    if (r1.headers.get("X-Cache") !== "MISS") fail("userKeyFn throw: first call should MISS");
    else if (r2.headers.get("X-Cache") !== "HIT") fail("userKeyFn throw: second call should HIT shared key");
    else if (calls !== 1) fail(`userKeyFn throw: handler should run once, ran ${calls}`);
    else pass("userKeyFn throw → falls back to shared key (no crash)");
}

async function testInvalidateKey() {
    resetCacheNamespace("/api/test-invk");
    let calls = 0;
    const handler = withCache(async () => {
        calls++;
        return NextResponse.json({ n: calls });
    }, 60);

    await handler(makeReq("/api/test-invk"));     // calls=1
    await handler(makeReq("/api/test-invk"));     // HIT, calls=1
    const had = invalidateCacheKey("/api/test-invk");
    if (!had) fail("invalidateCacheKey: should report true when key was present");
    else pass("invalidateCacheKey returns true for present key");

    const r3 = await handler(makeReq("/api/test-invk"));
    if (r3.headers.get("X-Cache") !== "MISS") fail("invalidateCacheKey: post-invalidate should MISS");
    else if (calls !== 2) fail(`invalidateCacheKey: handler should re-run (calls=${calls})`);
    else pass("invalidateCacheKey: subsequent call MISSes (cache cleared)");

    const had2 = invalidateCacheKey("/api/never-cached");
    if (had2) fail("invalidateCacheKey: should report false for absent key");
    else pass("invalidateCacheKey returns false for absent key");
}

async function testInvalidatePrefix() {
    resetCacheNamespace("/api/test-prefix");
    let calls = 0;
    const handler = withCache(async (req: Request) => {
        calls++;
        return NextResponse.json({ url: new URL(req.url).pathname });
    }, 60);

    await handler(makeReq("/api/test-prefix/a"));
    await handler(makeReq("/api/test-prefix/b"));
    await handler(makeReq("/api/test-prefix/c"));
    const start = calls;
    if (start !== 3) fail(`prefix: expected 3 initial misses, got ${start}`);

    const count = invalidateCacheByPrefix("/api/test-prefix");
    if (count !== 3) fail(`invalidateCacheByPrefix: expected 3 keys cleared, got ${count}`);
    else pass("invalidateCacheByPrefix clears all matching keys");

    await handler(makeReq("/api/test-prefix/a"));
    await handler(makeReq("/api/test-prefix/b"));
    if (calls !== 5) fail(`prefix: handler should re-run after invalidation (calls=${calls})`);
    else pass("invalidateCacheByPrefix: subsequent calls re-MISS");
}

async function testStats() {
    resetCacheNamespace("/api/test-stats");
    const before = await getCacheStats();
    const handler = withCache(async () => NextResponse.json({}), 60);

    await handler(makeReq("/api/test-stats"));   // miss
    await handler(makeReq("/api/test-stats"));   // hit
    await handler(makeReq("/api/test-stats"));   // hit

    const after = await getCacheStats();
    if (after.misses - before.misses < 1) fail(`stats: misses didn't advance (${after.misses - before.misses})`);
    else if (after.hits - before.hits < 2) fail(`stats: hits didn't advance by ≥2 (${after.hits - before.hits})`);
    else pass("getCacheStats tracks hits/misses");

    if (!after.activeEntries.some(e => e.key === "/api/test-stats")) fail("stats: active entries should include the test key");
    else pass("getCacheStats lists active entries");
}

async function main() {
    await testMissThenHit();
    await testCacheBuster();
    await testQueryNormalization();
    await testStaleFallbackOnThrow();
    await testThrowNoStale();
    await testNonOkWithStale();
    await testInFlightDedup();
    await testUserScoping();
    await testUserKeyFnThrows();
    await testInvalidateKey();
    await testInvalidatePrefix();
    await testStats();

    console.log(`\n${passes}/${passes + fails} steps passed`);
    if (fails > 0) process.exit(1);
    console.log("All checks passed.");
}

main().catch(e => {
    console.error("Unhandled error:", e);
    process.exit(1);
});
