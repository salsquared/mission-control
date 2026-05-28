/**
 * Hermetic smoke for the posting-parse result cache (lib/resumes/posting.ts).
 *
 * parsePosting memoizes its result per resolved posting content so generating
 * N tailored resume variants against the SAME posting doesn't re-call Gemini N
 * times. This smoke injects a counting `chatFn` (the test seam) and asserts:
 *
 *   - identical pasted text → second call is served from cache (0 LLM calls)
 *   - different text → cache miss (new LLM call)
 *   - URL-only input is cached on the URL (no fetch on the 2nd call)
 *   - whitespace-only differences collapse to the same key (clean() runs
 *     before hashing)
 *   - the returned object is a CLONE — mutating it can't poison the cache
 *   - _clearPostingParseCache() resets the cache
 *
 *   npx tsx scripts/tests/hermetic/posting-parse-cache-smoke.ts
 */

import { parsePosting, _clearPostingParseCache, type ChatJSONFn } from "@/lib/resumes/posting";

let passes = 0;
let fails = 0;
function pass(msg: string) { console.log(`[PASS] ${msg}`); passes++; }
function fail(msg: string, detail?: unknown) { console.error(`[FAIL] ${msg}`, detail ?? ""); fails++; }

// Counting fake chatJSON — returns a canned posting extract, tracks calls.
let chatCalls = 0;
const fakeChat: ChatJSONFn = (async () => {
    chatCalls++;
    return {
        title: "Backend Engineer",
        company: "Acme",
        location: "Remote",
        seniority: "Senior",
        keywords: [
            { keyword: "TypeScript", importance: 4 },
            { keyword: "Postgres", importance: 3 },
        ],
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
}) as any;

const LONG = "We are hiring a Senior Backend Engineer to build distributed systems in TypeScript and Postgres. ".repeat(3);

async function testTextCacheHit() {
    _clearPostingParseCache();
    chatCalls = 0;
    const a = await parsePosting({ text: LONG }, fakeChat);
    const b = await parsePosting({ text: LONG }, fakeChat);
    if (chatCalls !== 1) fail(`text-cache: expected 1 LLM call across 2 identical parses, got ${chatCalls}`);
    else pass("text-cache: 2nd identical parse served from cache (1 LLM call total)");
    if (a.company !== "Acme" || b.company !== "Acme") fail("text-cache: cached value shape wrong", { a, b });
    else pass("text-cache: cached result carries the same parsed fields");
}

async function testDifferentTextMisses() {
    _clearPostingParseCache();
    chatCalls = 0;
    await parsePosting({ text: LONG }, fakeChat);
    await parsePosting({ text: LONG + " Bonus: Kubernetes experience a plus, join our team today." }, fakeChat);
    if (chatCalls !== 2) fail(`distinct-text: expected 2 LLM calls for 2 distinct postings, got ${chatCalls}`);
    else pass("distinct-text: different posting text → cache miss → 2 LLM calls");
}

async function testWhitespaceCollapses() {
    _clearPostingParseCache();
    chatCalls = 0;
    await parsePosting({ text: LONG }, fakeChat);
    // Same content, extra/irregular internal whitespace — clean() normalizes
    // before hashing, so this must hit the same cache key.
    await parsePosting({ text: LONG.replace(/ /g, "   ") }, fakeChat);
    if (chatCalls !== 1) fail(`whitespace: expected 1 LLM call (whitespace-normalized to same key), got ${chatCalls}`);
    else pass("whitespace: irregular spacing collapses to the same cache key (1 LLM call)");
}

async function testUrlCache() {
    _clearPostingParseCache();
    chatCalls = 0;
    let fetchCount = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
        fetchCount++;
        return new Response(
            "<html><body><main>Senior Backend Engineer at Acme. Build distributed systems in TypeScript and Postgres. Apply now to join.</main></body></html>",
            { status: 200, headers: { "content-type": "text/html" } },
        );
    }) as typeof fetch;
    try {
        await parsePosting({ url: "https://jobs.example.com/123" }, fakeChat);
        await parsePosting({ url: "https://jobs.example.com/123" }, fakeChat);
    } finally {
        globalThis.fetch = realFetch;
    }
    if (chatCalls !== 1) fail(`url-cache: expected 1 LLM call across 2 same-URL parses, got ${chatCalls}`);
    else pass("url-cache: 2nd same-URL parse served from cache (1 LLM call)");
    if (fetchCount !== 1) fail(`url-cache: expected 1 fetch (2nd elided by cache), got ${fetchCount}`);
    else pass("url-cache: cache hit skips the URL fetch entirely (1 fetch)");
}

async function testReturnedCloneIsolated() {
    _clearPostingParseCache();
    chatCalls = 0;
    const first = await parsePosting({ text: LONG }, fakeChat);
    // Mutate the returned object — must NOT affect the cached copy.
    first.keywords.push("INJECTED");
    first.company = "Mutated";
    const second = await parsePosting({ text: LONG }, fakeChat);
    if (second.keywords.includes("INJECTED") || second.company === "Mutated") {
        fail("clone-isolation: mutation of a returned parse leaked into the cache", second);
    } else pass("clone-isolation: returned objects are clones — cache stays pristine");
    if (chatCalls !== 1) fail(`clone-isolation: expected 1 LLM call, got ${chatCalls}`);
    else pass("clone-isolation: still a cache hit after mutation (1 LLM call)");
}

async function testClearResets() {
    _clearPostingParseCache();
    chatCalls = 0;
    await parsePosting({ text: LONG }, fakeChat);
    _clearPostingParseCache();
    await parsePosting({ text: LONG }, fakeChat);
    if (chatCalls !== 2) fail(`clear: expected 2 LLM calls (cache cleared between), got ${chatCalls}`);
    else pass("clear: _clearPostingParseCache() forces a fresh parse (2 LLM calls)");
}

async function main() {
    await testTextCacheHit();
    await testDifferentTextMisses();
    await testWhitespaceCollapses();
    await testUrlCache();
    await testReturnedCloneIsolated();
    await testClearResets();
    console.log(`\n${passes}/${passes + fails} steps passed`);
    if (fails > 0) {
        console.error(`${fails} failure(s).`);
        process.exit(1);
    }
    console.log("All checks passed.");
}

main().catch(e => { console.error("Smoke crashed:", e); process.exit(2); });
