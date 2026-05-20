/**
 * Hermetic smoke for the topical-discovery orchestrator. Stubs Gemini via the
 * `_suggestFn` seam and mocks fetch to validate:
 *
 *   - slug-candidate generation (canonical / dashed / underscored / suffix-
 *     stripped variants from human company names)
 *   - the canonical slug short-circuits on first probe when greenhouse hits
 *   - ATS fallback within a single slug variant (gh → lever → ashby)
 *   - slug-variant fallback when the canonical variant 404s everywhere
 *   - suffix-stripping ("Foo Inc" also probes slug="foo")
 *   - exclude list filters case-insensitively pre-probe
 *   - all probes fail → routes to unverified with a useful reason
 *   - the 24h resolve cache: second call for the same company makes zero
 *     outbound HTTP calls
 *   - empty topic is rejected
 *
 *   npx tsx scripts/tests/hermetic/discovery-suggest-smoke.ts
 */

// Disable L2 SQLite cache so the smoke is hermetic — relies on L1 only, which
// we clear between tests below. Read at cachedValue() call time, so setting
// before the cache module is actually consulted is sufficient.
process.env.CACHE_BACKEND = "memory";

import { suggestCompanies } from "@/lib/discovery/suggest";
import { generateSlugCandidates } from "@/lib/discovery/slug-probe";

let passes = 0;
let fails = 0;
function pass(msg: string) { console.log(`[PASS] ${msg}`); passes++; }
function fail(msg: string, detail?: unknown) { console.error(`[FAIL] ${msg}`, detail ?? ""); fails++; }

// ─── fetch mocking with exact-slug matching + call counting ──────────────

type ProbeKind = "greenhouse" | "lever" | "ashby";

interface ProbeFixture {
    kind: ProbeKind;
    slug: string;
    status?: number;
    jobs?: number;
}

let probeFixtures: ProbeFixture[] = [];
let fetchCount = 0;

function setProbes(fixtures: ProbeFixture[]) { probeFixtures = fixtures; }
function resetFetchCount() { fetchCount = 0; }

// Extract (kind, slug) by URL pattern instead of naive substring — naive
// matching causes prefix collisions ("stuff" matching "stuffinc").
function parseProbeUrl(url: string): { kind: ProbeKind; slug: string } | null {
    if (url.includes("boards-api.greenhouse.io")) {
        const m = /\/boards\/([^/]+)\/jobs/.exec(url);
        return m ? { kind: "greenhouse", slug: m[1] } : null;
    }
    if (url.includes("api.lever.co")) {
        const m = /\/postings\/([^/?]+)/.exec(url);
        return m ? { kind: "lever", slug: m[1] } : null;
    }
    if (url.includes("api.ashbyhq.com")) {
        const m = /\/job-board\/([^/?]+)/.exec(url);
        return m ? { kind: "ashby", slug: m[1] } : null;
    }
    return null;
}

globalThis.fetch = (async (input: RequestInfo | URL) => {
    fetchCount++;
    const url = typeof input === "string" ? input : input.toString();
    const parsed = parseProbeUrl(url);
    if (!parsed) {
        // Fail loudly on unexpected hosts — tests should only hit known ATS endpoints.
        return new Response("unknown host", { status: 599 }) as unknown as Response;
    }
    for (const fx of probeFixtures) {
        if (fx.kind === parsed.kind && fx.slug === parsed.slug) {
            const status = fx.status ?? 200;
            if (status >= 400) {
                return new Response(JSON.stringify({ error: "not found" }), { status }) as unknown as Response;
            }
            // Build a body matching the ATS's envelope shape.
            const body = fx.kind === "lever"
                ? Array.from({ length: fx.jobs ?? 0 }, (_, i) => ({ id: i }))
                : { jobs: Array.from({ length: fx.jobs ?? 0 }, (_, i) => ({ id: i })) };
            return new Response(JSON.stringify(body), { status: 200 }) as unknown as Response;
        }
    }
    // Default: 404 — lets tests declare ONLY the hits, with non-matches implicit.
    return new Response(JSON.stringify({ error: "not found" }), { status: 404 }) as unknown as Response;
}) as typeof fetch;

function clearCache() {
    const cache = (globalThis as { apiCache?: Map<string, unknown> }).apiCache;
    if (cache) cache.clear();
}

// ─── Test 1: slug-candidate generation ───────────────────────────────────

function testSlugCandidates() {
    const cases: Array<{ in: string; mustInclude: string[] }> = [
        { in: "Anthropic", mustInclude: ["anthropic"] },
        { in: "Blue Origin", mustInclude: ["blueorigin", "blue-origin"] },
        { in: "SpaceX", mustInclude: ["spacex"] },
        // suffix-stripping: "Inc" → also try the bare stem
        { in: "Stuff Inc", mustInclude: ["stuffinc", "stuff"] },
    ];
    for (const c of cases) {
        const out = generateSlugCandidates(c.in);
        const miss = c.mustInclude.filter(s => !out.includes(s));
        if (miss.length) fail(`slug-candidates "${c.in}" missing ${JSON.stringify(miss)} (got ${JSON.stringify(out)})`);
        else pass(`slug-candidates "${c.in}" includes ${JSON.stringify(c.mustInclude)}`);
    }
}

// ─── Test 2: canonical slug short-circuits on first probe ────────────────

async function testCanonicalHitFirst() {
    clearCache();
    resetFetchCount();
    setProbes([{ kind: "greenhouse", slug: "fasthitco", jobs: 7 }]);
    const r = await suggestCompanies({
        topic: "space",
        _suggestFn: async () => ({ candidates: [{ name: "FastHitCo", blurb: "x", careersUrl: "" }] }),
    });
    if (r.verified.length !== 1) fail(`canonical: expected 1 verified, got ${r.verified.length}`);
    else if (r.verified[0].kind !== "greenhouse" || r.verified[0].slug !== "fasthitco" || r.verified[0].jobCount !== 7) {
        fail("canonical: wrong winner", r.verified[0]);
    } else pass("canonical: greenhouse:fasthitco found on first try (7 jobs)");
    if (fetchCount !== 1) fail(`canonical short-circuit: expected 1 fetch, got ${fetchCount}`);
    else pass("canonical: sequential probe stopped after greenhouse hit (1 fetch)");
}

// ─── Test 3: ATS fallback within one slug variant ────────────────────────

async function testAtsFallback() {
    clearCache();
    resetFetchCount();
    setProbes([{ kind: "ashby", slug: "ashbyonly", jobs: 3 }]);
    const r = await suggestCompanies({
        topic: "space",
        _suggestFn: async () => ({ candidates: [{ name: "AshbyOnly", blurb: "x", careersUrl: "" }] }),
    });
    if (r.verified.length !== 1 || r.verified[0].kind !== "ashby" || r.verified[0].slug !== "ashbyonly") {
        fail("ats-fallback: expected ashby:ashbyonly winner", r.verified);
    } else pass("ats-fallback: ashby probed after greenhouse + lever 404s");
    if (fetchCount !== 3) fail(`ats-fallback: expected 3 fetches (gh+lever+ashby), got ${fetchCount}`);
    else pass("ats-fallback: 3 probes for one slug variant before ashby hit");
}

// ─── Test 4: slug-variant fallback (canonical 404, dashed wins) ──────────

async function testSlugVariantFallback() {
    clearCache();
    resetFetchCount();
    // "Multi Word Co" → variants: ["multiwordco", "multi-word-co", "multi_word_co", "multiword"]
    // Mock only lever:multi-word-co. Canonical "multiwordco" 404s on all 3,
    // then "multi-word-co" hits lever on the second probe of that variant.
    setProbes([{ kind: "lever", slug: "multi-word-co", jobs: 2 }]);
    const r = await suggestCompanies({
        topic: "space",
        _suggestFn: async () => ({ candidates: [{ name: "Multi Word Co", blurb: "x", careersUrl: "" }] }),
    });
    if (r.verified.length !== 1 || r.verified[0].slug !== "multi-word-co" || r.verified[0].kind !== "lever") {
        fail("variant-fallback: wrong winner", r.verified);
    } else pass("variant-fallback: lever:multi-word-co wins after canonical 404s");
}

// ─── Test 5: suffix stripping ("Stuff Inc" → "stuff") ────────────────────

async function testSuffixStripping() {
    clearCache();
    resetFetchCount();
    // "Stuff Inc" variants: ["stuffinc", "stuff-inc", "stuff_inc", "stuff"]
    setProbes([{ kind: "greenhouse", slug: "stuff", jobs: 9 }]);
    const r = await suggestCompanies({
        topic: "space",
        _suggestFn: async () => ({ candidates: [{ name: "Stuff Inc", blurb: "x", careersUrl: "" }] }),
    });
    if (r.verified.length !== 1 || r.verified[0].slug !== "stuff" || r.verified[0].kind !== "greenhouse") {
        fail("suffix-strip: expected greenhouse:stuff (suffix-stripped)", r.verified);
    } else pass("suffix-strip: greenhouse:stuff wins for 'Stuff Inc' after canonical 404s");
}

// ─── Test 6: all probes fail → unverified ────────────────────────────────

async function testAllFail() {
    clearCache();
    resetFetchCount();
    setProbes([]); // every URL 404s by default
    const r = await suggestCompanies({
        topic: "space",
        _suggestFn: async () => ({ candidates: [{ name: "Nonexistent Mystery", blurb: "x", careersUrl: "https://nope.example/careers" }] }),
    });
    if (r.verified.length !== 0) fail(`all-fail: expected 0 verified, got ${r.verified.length}`);
    else pass("all-fail: 0 verified");
    if (r.unverified.length !== 1) fail(`all-fail: expected 1 unverified, got ${r.unverified.length}`);
    else if (!r.unverified[0].reason.toLowerCase().includes("no public")) {
        fail("all-fail: reason text missing 'no public'", r.unverified[0].reason);
    } else if (r.unverified[0].atsGuess !== "unknown") {
        fail("all-fail: expected atsGuess='unknown'", r.unverified[0].atsGuess);
    } else pass("all-fail: routed to unverified with no-public-board reason");
}

// ─── Test 7: excludes work + case-insensitive ────────────────────────────

async function testExcludes() {
    clearCache();
    resetFetchCount();
    setProbes([{ kind: "greenhouse", slug: "keepco", jobs: 1 }]);
    const r = await suggestCompanies({
        topic: "space",
        exclude: ["SkipCo"],
        _suggestFn: async () => ({ candidates: [
            { name: "SkipCo", blurb: "x", careersUrl: "" },
            { name: "skipco", blurb: "x", careersUrl: "" },
            { name: "KeepCo", blurb: "x", careersUrl: "" },
        ] }),
    });
    if (r.excludedCount !== 2) fail(`excludes: expected excludedCount=2, got ${r.excludedCount}`);
    else pass("excludes: 2 case-insensitive matches dropped pre-probe");
    if (r.verified.length !== 1 || r.verified[0].name !== "KeepCo") {
        fail("excludes: KeepCo should be the only verified entry", r.verified);
    } else pass("excludes: KeepCo survived and resolved");
}

// ─── Test 8: cache hit on second call ────────────────────────────────────

async function testCacheHits() {
    clearCache();
    setProbes([{ kind: "greenhouse", slug: "cacheco", jobs: 4 }]);

    resetFetchCount();
    const r1 = await suggestCompanies({
        topic: "space",
        _suggestFn: async () => ({ candidates: [{ name: "CacheCo", blurb: "x", careersUrl: "" }] }),
    });
    const firstFetches = fetchCount;
    if (r1.verified.length !== 1) fail("cache: first call should resolve");
    if (firstFetches !== 1) fail(`cache: first call expected 1 fetch, got ${firstFetches}`);
    else pass("cache: first call made 1 outbound probe");

    resetFetchCount();
    const r2 = await suggestCompanies({
        topic: "space",
        _suggestFn: async () => ({ candidates: [{ name: "CacheCo", blurb: "x", careersUrl: "" }] }),
    });
    if (r2.verified.length !== 1) fail("cache: second call should still resolve via cache");
    if (fetchCount !== 0) fail(`cache: second call expected 0 fetches (cached), got ${fetchCount}`);
    else pass("cache: second call returned cached resolution (0 fetches)");
}

// ─── Test 9: empty topic rejected ────────────────────────────────────────

async function testEmptyTopic() {
    try {
        await suggestCompanies({ topic: "  ", _suggestFn: async () => ({ candidates: [] }) });
        fail("empty-topic: expected throw, got success");
    } catch (e) {
        if ((e as Error).message.toLowerCase().includes("topic")) pass("empty-topic: throws with helpful message");
        else fail("empty-topic: threw but wrong message", (e as Error).message);
    }
}

async function main() {
    testSlugCandidates();
    await testCanonicalHitFirst();
    await testAtsFallback();
    await testSlugVariantFallback();
    await testSuffixStripping();
    await testAllFail();
    await testExcludes();
    await testCacheHits();
    await testEmptyTopic();
    console.log(`\n${passes}/${passes + fails} steps passed`);
    if (fails > 0) {
        console.error(`${fails} failure(s).`);
        process.exit(1);
    }
    console.log("All checks passed.");
}

main().catch(e => { console.error("Smoke crashed:", e); process.exit(2); });
