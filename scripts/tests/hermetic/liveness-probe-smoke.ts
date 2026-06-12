/**
 * Hermetic smoke for the close-detection probe gate.
 *
 * Design + rationale: docs/archive/close-detection-probe.md.
 *
 * Stubs globalThis.fetch with per-test fixture handlers and asserts:
 *   - Each ATS kind routes through its dedicated probe.
 *   - Status codes resolve to alive/closed/unknown as documented.
 *   - LinkedIn closure markers + redirect-to-search are honored.
 *   - OQ4b positive-evidence redirects: authwall/login/signup/challenge
 *     interstitials → "unknown"; only the board's own jobs-search/root
 *     surface (or a body closed-marker) counts as closure evidence.
 *   - P3.1b SSRF redirect loop: every hop is guarded (redirect to a private
 *     IP is never fetched → "unknown"), >MAX hops → "unknown", benign
 *     redirects (incl. relative Locations) are still followed.
 *   - P3.1c: MC_LIVENESS_BYPASS is ignored on a production tier.
 *   - probeBatch respects maxPerTick (overflow → unknown).
 *   - probeBatch respects concurrency (no more than N in flight at once).
 *   - probeBatch honors perHitDelayMs between same-host hits.
 *
 *   DATABASE_URL="file:./dev.db" npx tsx scripts/tests/hermetic/liveness-probe-smoke.ts
 *
 * Pure logic — no DB writes, no real network.
 */
import {
    probePostingLiveness,
    probeBatch,
    PROBE_PROFILES,
    type LivenessResult,
    type ProbeInput,
    type WatchlistKind,
} from "@/lib/postings/liveness";

let passes = 0;
let fails = 0;
function pass(msg: string) { console.log(`[PASS] ${msg}`); passes++; }
function fail(msg: string, detail?: unknown) { console.error(`[FAIL] ${msg}`, detail ?? ""); fails++; }

interface MockHandler {
    matches: (url: string) => boolean;
    /** Either a Response (object) or an error to throw. */
    respond: (url: string) => Promise<Response> | Response | Promise<never>;
}

interface InstalledMock {
    callCount: () => number;
    callLog: () => Array<{ url: string; t: number }>;
    inFlightPeak: () => number;
    restore: () => void;
}

function installFetchMock(handlers: MockHandler[]): InstalledMock {
    const original = globalThis.fetch;
    let callCount = 0;
    let inFlight = 0;
    let inFlightPeak = 0;
    const callLog: Array<{ url: string; t: number }> = [];
    const t0 = Date.now();
    globalThis.fetch = (async (input: RequestInfo | URL, _init?: RequestInit) => {
        callCount++;
        inFlight++;
        if (inFlight > inFlightPeak) inFlightPeak = inFlight;
        const url = typeof input === "string" ? input : input.toString();
        callLog.push({ url, t: Date.now() - t0 });
        try {
            for (const h of handlers) {
                if (h.matches(url)) {
                    const result = await h.respond(url);
                    return result;
                }
            }
            throw new Error(`unstubbed fetch: ${url}`);
        } finally {
            inFlight--;
        }
    }) as typeof fetch;
    return {
        callCount: () => callCount,
        callLog: () => callLog,
        inFlightPeak: () => inFlightPeak,
        restore: () => { globalThis.fetch = original; },
    };
}

function respond200(body: string, finalUrl?: string): Response {
    // Spread `url` via the Response options pattern. Web Response doesn't take
    // url directly; we set it via Object.defineProperty since some fetch
    // shims read response.url for the post-redirect URL.
    const res = new Response(body, { status: 200, headers: { "content-type": "text/html" } });
    if (finalUrl) Object.defineProperty(res, "url", { value: finalUrl, writable: false });
    return res;
}

function respondStatus(status: number, body = ""): Response {
    return new Response(body, { status });
}

/** A real 3xx with a Location header — exercises the manual redirect loop. */
function respondRedirect(location: string, status = 302): Response {
    return new Response(null, { status, headers: { location } });
}

async function expectResult(actual: LivenessResult, expected: LivenessResult, msg: string) {
    if (actual === expected) pass(msg);
    else fail(`${msg} — expected ${expected}, got ${actual}`);
}

// ─── Per-kind dispatch + status routing ───────────────────────────────────

async function testGenericStatusCodes() {
    const kinds: WatchlistKind[] = ["smartrecruiters", "workable", "recruitee", "personio", "clearcompany", "careers-page"];
    for (const kind of kinds) {
        // 404
        let stub = installFetchMock([{ matches: () => true, respond: () => respondStatus(404) }]);
        let r = await probePostingLiveness({ externalId: "x", sourceUrl: `https://example.com/${kind}/x` }, kind);
        await expectResult(r, "closed", `${kind}: 404 → closed`);
        stub.restore();

        // 410
        stub = installFetchMock([{ matches: () => true, respond: () => respondStatus(410) }]);
        r = await probePostingLiveness({ externalId: "x", sourceUrl: `https://example.com/${kind}/x` }, kind);
        await expectResult(r, "closed", `${kind}: 410 → closed`);
        stub.restore();

        // 200 → alive
        stub = installFetchMock([{ matches: () => true, respond: () => respondStatus(200, "ok") }]);
        r = await probePostingLiveness({ externalId: "x", sourceUrl: `https://example.com/${kind}/x` }, kind);
        await expectResult(r, "alive", `${kind}: 200 → alive`);
        stub.restore();

        // 500 → unknown
        stub = installFetchMock([{ matches: () => true, respond: () => respondStatus(500) }]);
        r = await probePostingLiveness({ externalId: "x", sourceUrl: `https://example.com/${kind}/x` }, kind);
        await expectResult(r, "unknown", `${kind}: 500 → unknown`);
        stub.restore();

        // 429 → unknown (telegraphs back-off)
        stub = installFetchMock([{ matches: () => true, respond: () => respondStatus(429) }]);
        r = await probePostingLiveness({ externalId: "x", sourceUrl: `https://example.com/${kind}/x` }, kind);
        await expectResult(r, "unknown", `${kind}: 429 → unknown`);
        stub.restore();

        // Network throw → unknown
        stub = installFetchMock([{ matches: () => true, respond: () => { throw new Error("ECONNRESET"); } }]);
        r = await probePostingLiveness({ externalId: "x", sourceUrl: `https://example.com/${kind}/x` }, kind);
        await expectResult(r, "unknown", `${kind}: network-throw → unknown`);
        stub.restore();
    }
}

// ─── LinkedIn-specific heuristics ─────────────────────────────────────────

async function testLinkedinAlive() {
    const stub = installFetchMock([{
        matches: (u) => u.includes("linkedin.com/jobs/view/"),
        respond: (u) => respond200(
            `<html><body><div class="top-card-layout">Job Title</div><div class="description__text">Body</div></body></html>`,
            u,
        ),
    }]);
    const r = await probePostingLiveness({
        externalId: "a",
        sourceUrl: "https://www.linkedin.com/jobs/view/test-at-acme-12345",
    }, "linkedin");
    await expectResult(r, "alive", "linkedin: 200 + view URL + alive markers → alive");
    stub.restore();
}

async function testLinkedinClosedRedirect() {
    const stub = installFetchMock([{
        matches: (u) => u.includes("linkedin.com"),
        // Simulated redirect: response.url moved to /jobs/search.
        respond: () => respond200(
            `<html><body>browse jobs</body></html>`,
            "https://www.linkedin.com/jobs/search?keywords=fallback",
        ),
    }]);
    const r = await probePostingLiveness({
        externalId: "a",
        sourceUrl: "https://www.linkedin.com/jobs/view/test-at-acme-12345",
    }, "linkedin");
    await expectResult(r, "closed", "linkedin: redirected away from /jobs/view/ → closed");
    stub.restore();
}

async function testLinkedinClosedMarker() {
    const stub = installFetchMock([{
        matches: (u) => u.includes("linkedin.com/jobs/view/"),
        respond: (u) => respond200(
            `<html><body><div class="top-card-layout">Old Job</div><p>This job is no longer available.</p></body></html>`,
            u,
        ),
    }]);
    const r = await probePostingLiveness({
        externalId: "a",
        sourceUrl: "https://www.linkedin.com/jobs/view/test-at-acme-12345",
    }, "linkedin");
    await expectResult(r, "closed", "linkedin: body marker 'no longer available' → closed");
    stub.restore();
}

async function testLinkedinAmbiguous() {
    const stub = installFetchMock([{
        matches: (u) => u.includes("linkedin.com/jobs/view/"),
        // 200 + URL retained but NO alive markers and NO closure markers → unknown.
        respond: (u) => respond200(`<html><body>placeholder</body></html>`, u),
    }]);
    const r = await probePostingLiveness({
        externalId: "a",
        sourceUrl: "https://www.linkedin.com/jobs/view/test-at-acme-12345",
    }, "linkedin");
    await expectResult(r, "unknown", "linkedin: 200 with neither closed nor alive markers → unknown");
    stub.restore();
}

async function testLinkedin404() {
    const stub = installFetchMock([{
        matches: (u) => u.includes("linkedin.com"),
        respond: () => respondStatus(404),
    }]);
    const r = await probePostingLiveness({
        externalId: "a",
        sourceUrl: "https://www.linkedin.com/jobs/view/test-at-acme-12345",
    }, "linkedin");
    await expectResult(r, "closed", "linkedin: 404 → closed");
    stub.restore();
}

// ─── Greenhouse / Lever API path ──────────────────────────────────────────

async function testGreenhouseUsesApi() {
    let apiHit = false;
    const stub = installFetchMock([{
        matches: (u) => u.includes("boards-api.greenhouse.io"),
        respond: () => { apiHit = true; return respondStatus(404); },
    }, {
        matches: () => true,
        respond: () => respondStatus(200, "html"),
    }]);
    const r = await probePostingLiveness({
        externalId: "a",
        sourceUrl: "https://job-boards.greenhouse.io/anthropic/jobs/5126702008",
    }, "greenhouse");
    await expectResult(r, "closed", "greenhouse: parsed slug+id → boards-api 404 → closed");
    if (!apiHit) fail("greenhouse: expected boards-api.greenhouse.io to be hit");
    else pass("greenhouse: used boards-api endpoint, not source HTML");
    stub.restore();
}

async function testLeverUsesApi() {
    let apiHit = false;
    const stub = installFetchMock([{
        matches: (u) => u.startsWith("https://api.lever.co/v0/postings/"),
        respond: () => { apiHit = true; return respondStatus(404); },
    }, {
        matches: () => true,
        respond: () => respondStatus(200, "html"),
    }]);
    const r = await probePostingLiveness({
        externalId: "a",
        sourceUrl: "https://jobs.lever.co/epsilon3/95b0ec88-a6bc-492c-b6e9-c80086c666ea",
    }, "lever");
    await expectResult(r, "closed", "lever: parsed slug+uuid → api.lever.co 404 → closed");
    if (!apiHit) fail("lever: expected api.lever.co to be hit");
    else pass("lever: used api.lever.co endpoint, not source HTML");
    stub.restore();
}

async function testGreenhouseFallbackToSourceUrl() {
    // sourceUrl doesn't match the regex — should fall back to HTML probe.
    let htmlHit = false;
    let apiHit = false;
    const stub = installFetchMock([{
        matches: (u) => u.includes("boards-api.greenhouse.io"),
        respond: () => { apiHit = true; return respondStatus(404); },
    }, {
        matches: (u) => u.includes("custom-careers.example.com"),
        respond: () => { htmlHit = true; return respondStatus(404); },
    }]);
    const r = await probePostingLiveness({
        externalId: "a",
        sourceUrl: "https://custom-careers.example.com/job/12345",
    }, "greenhouse");
    await expectResult(r, "closed", "greenhouse: regex miss → HTML fallback → closed");
    if (apiHit) fail("greenhouse: should NOT have hit boards-api for non-matching URL");
    if (!htmlHit) fail("greenhouse: expected fallback to source HTML for non-matching URL");
    else pass("greenhouse: fell back to source HTML when URL didn't match canonical pattern");
    stub.restore();
}

// ─── Workday-specific behavior ────────────────────────────────────────────

async function testWorkdayLoginRedirect() {
    // OQ4b — an auth-gate redirect is ambiguity, NOT closure evidence (used
    // to be "closed" pre-2026-06-12).
    const stub = installFetchMock([{
        matches: () => true,
        respond: () => respond200("login form", "https://boeing.wd1.myworkdayjobs.com/en-US/EXTERNAL_CAREERS/login"),
    }]);
    const r = await probePostingLiveness({
        externalId: "a",
        sourceUrl: "https://boeing.wd1.myworkdayjobs.com/en-US/EXTERNAL_CAREERS/job/USA/Engineer_JR1",
    }, "workday");
    await expectResult(r, "unknown", "workday: redirect to /login → unknown (auth gate is not closure evidence, OQ4b)");
    stub.restore();
}

async function testWorkdayBoardRootRedirect() {
    // OQ4b allowlist — a dead Workday posting redirects to the tenant's own
    // board root (locale/site, no /job/ segment): genuine closure evidence.
    const stub = installFetchMock([{
        // CXS JSON probe runs first for the canonical URL — return a 200 with
        // no recognizable flags so probeWorkday falls back to the HTML probe.
        matches: (u) => u.includes("/wday/cxs/"),
        respond: (u) => respond200("{}", u),
    }, {
        matches: () => true,
        respond: () => respond200("career site landing", "https://boeing.wd1.myworkdayjobs.com/en-US/EXTERNAL_CAREERS"),
    }]);
    const r = await probePostingLiveness({
        externalId: "a",
        sourceUrl: "https://boeing.wd1.myworkdayjobs.com/en-US/EXTERNAL_CAREERS/job/USA/Engineer_JR1",
    }, "workday");
    await expectResult(r, "closed", "workday: redirect to tenant board root → closed (own-surface allowlist)");
    stub.restore();
}

async function testWorkdayAlive() {
    const stub = installFetchMock([{
        matches: () => true,
        respond: (u) => respond200(`<html><body data-automation-id="jobPostingPage">Job</body></html>`, u),
    }]);
    const r = await probePostingLiveness({
        externalId: "a",
        sourceUrl: "https://boeing.wd1.myworkdayjobs.com/en-US/EXTERNAL_CAREERS/job/USA/Engineer_JR1",
    }, "workday");
    await expectResult(r, "alive", "workday: 200 + /job/ in URL → alive");
    stub.restore();
}

// ─── Ashby-specific behavior ──────────────────────────────────────────────

async function testAshbyBareRootRedirect() {
    const stub = installFetchMock([{
        matches: () => true,
        // Posting URL was jobs.ashbyhq.com/langchain/<uuid> but redirected to
        // bare board /langchain — no posting.
        respond: () => respond200("board page", "https://jobs.ashbyhq.com/langchain"),
    }]);
    const r = await probePostingLiveness({
        externalId: "a",
        sourceUrl: "https://jobs.ashbyhq.com/langchain/faeb56fd-e7d6-47d6-babe-e35315969206",
    }, "ashby");
    await expectResult(r, "closed", "ashby: redirect to bare board root → closed");
    stub.restore();
}

// ─── OQ4b — positive-evidence redirect classification ────────────────────

async function testAuthInterstitialRedirectsUnknown() {
    // Authwall / login / signup / challenge interstitials must classify
    // "unknown" — they say nothing about the posting. Real 302s, so the
    // manual redirect loop is exercised end-to-end.
    const cases: Array<{ kind: WatchlistKind; sourceUrl: string; interstitial: string; label: string }> = [
        {
            kind: "linkedin",
            sourceUrl: "https://www.linkedin.com/jobs/view/test-at-acme-12345",
            interstitial: "https://www.linkedin.com/authwall?trk=qf&sessionRedirect=x",
            label: "linkedin: 302 → authwall",
        },
        {
            kind: "linkedin",
            sourceUrl: "https://www.linkedin.com/jobs/view/test-at-acme-12345",
            interstitial: "https://www.linkedin.com/uas/login?session_redirect=%2Fjobs",
            label: "linkedin: 302 → /uas/login",
        },
        {
            kind: "linkedin",
            sourceUrl: "https://www.linkedin.com/jobs/view/test-at-acme-12345",
            interstitial: "https://www.linkedin.com/checkpoint/challenge/abc123",
            label: "linkedin: 302 → /checkpoint/challenge",
        },
        {
            kind: "linkedin",
            sourceUrl: "https://www.linkedin.com/jobs/view/test-at-acme-12345",
            interstitial: "https://www.linkedin.com/signup/cold-join",
            label: "linkedin: 302 → /signup",
        },
        {
            kind: "indeed",
            sourceUrl: "https://www.indeed.com/viewjob?jk=abc123",
            interstitial: "https://secure.indeed.com/account/login?dest=%2Fviewjob",
            label: "indeed: 302 → account login",
        },
    ];
    for (const c of cases) {
        const stub = installFetchMock([{
            matches: (u) => u === c.sourceUrl,
            respond: () => respondRedirect(c.interstitial),
        }, {
            matches: (u) => u.startsWith(c.interstitial.split("?")[0]),
            respond: (u) => respond200("<html><body>sign in to continue</body></html>", u),
        }]);
        const r = await probePostingLiveness({ externalId: "x", sourceUrl: c.sourceUrl }, c.kind);
        await expectResult(r, "unknown", `${c.label} → unknown (interstitial is not closure evidence)`);
        stub.restore();
    }
}

async function testBoardSearchRootRedirectsClosed() {
    // The board's OWN jobs-search / root surface IS genuine closure evidence
    // (a dead posting gets parked there). LinkedIn case uses a RELATIVE
    // Location to assert the loop resolves it against the current URL.
    const cases: Array<{ kind: WatchlistKind; sourceUrl: string; location: string; finalUrl: string; label: string }> = [
        {
            kind: "linkedin",
            sourceUrl: "https://www.linkedin.com/jobs/view/test-at-acme-12345",
            location: "/jobs/search?keywords=fallback&trk=expired_jd_redirect",
            finalUrl: "https://www.linkedin.com/jobs/search",
            label: "linkedin: 302 → /jobs/search (relative Location)",
        },
        {
            kind: "indeed",
            sourceUrl: "https://www.indeed.com/viewjob?jk=abc123",
            location: "https://www.indeed.com/jobs?q=software+engineer",
            finalUrl: "https://www.indeed.com/jobs",
            label: "indeed: 302 → /jobs search",
        },
        {
            kind: "indeed",
            sourceUrl: "https://www.indeed.com/viewjob?jk=abc123",
            location: "https://www.indeed.com/",
            finalUrl: "https://www.indeed.com/",
            label: "indeed: 302 → homepage root",
        },
    ];
    for (const c of cases) {
        const stub = installFetchMock([{
            matches: (u) => u === c.sourceUrl,
            respond: () => respondRedirect(c.location),
        }, {
            matches: (u) => u.startsWith(c.finalUrl),
            respond: (u) => respond200("<html><body>browse jobs</body></html>", u),
        }]);
        const r = await probePostingLiveness({ externalId: "x", sourceUrl: c.sourceUrl }, c.kind);
        await expectResult(r, "closed", `${c.label} → closed (board's own search/root surface)`);
        stub.restore();
    }
}

async function testOffPathBodyMarkerStillCloses() {
    // (b) of OQ4b — wherever the redirect landed, a body closed-marker is
    // positive evidence. Off-path + marker → closed even though the URL is
    // neither the posting path nor the search-root allowlist.
    const stub = installFetchMock([{
        matches: (u) => u.includes("/jobs/view/"),
        respond: () => respondRedirect("https://www.linkedin.com/jobs/collections/expired-notice"),
    }, {
        matches: (u) => u.includes("/jobs/collections/"),
        respond: (u) => respond200("<html><body>This job is no longer available.</body></html>", u),
    }]);
    const r = await probePostingLiveness({
        externalId: "x",
        sourceUrl: "https://www.linkedin.com/jobs/view/test-at-acme-12345",
    }, "linkedin");
    await expectResult(r, "closed", "linkedin: off-path redirect + body closed-marker → closed");
    stub.restore();
}

// ─── P3.1b — SSRF-safe redirect loop ──────────────────────────────────────

async function testRedirectToPrivateIpBlocked() {
    // A 302 to an internal target must never be fetched: the per-hop guard
    // trips BEFORE the follow, verdict is "unknown" (never "closed", even if
    // the internal target would 404).
    const targets = [
        "http://127.0.0.1:9999/secret",
        "http://169.254.169.254/latest/meta-data/",
        "http://192.168.1.10/admin",
    ];
    for (const target of targets) {
        let privateFetched = false;
        const stub = installFetchMock([{
            matches: (u) => u === target,
            respond: () => { privateFetched = true; return respondStatus(404); },
        }, {
            matches: () => true,
            respond: () => respondRedirect(target),
        }]);
        const r = await probePostingLiveness({
            externalId: "x",
            sourceUrl: "https://example.com/posting/x",
        }, "careers-page");
        await expectResult(r, "unknown", `SSRF loop: 302 → ${target} → unknown`);
        if (privateFetched) fail(`SSRF loop: private target ${target} was FETCHED — hop guard failed`);
        else pass(`SSRF loop: private target ${target} never fetched (guard fired pre-follow)`);
        if (stub.callCount() !== 1) fail(`SSRF loop: expected exactly 1 fetch, got ${stub.callCount()}`);
        stub.restore();
    }
}

async function testRedirectHopCapUnknown() {
    // An endless redirect chain resolves "unknown" after MAX_REDIRECT_HOPS
    // (5) follows: 1 initial fetch + 5 follows = 6 fetches, then stop.
    let n = 0;
    const stub = installFetchMock([{
        matches: () => true,
        respond: () => respondRedirect(`https://example.com/hop-${++n}`),
    }]);
    const r = await probePostingLiveness({
        externalId: "x",
        sourceUrl: "https://example.com/posting/x",
    }, "careers-page");
    await expectResult(r, "unknown", "redirect chain >5 hops → unknown");
    if (stub.callCount() === 6) pass(`hop cap: stopped after ${stub.callCount()} fetches (1 initial + 5 follows)`);
    else fail(`hop cap: expected 6 fetches, got ${stub.callCount()}`);
    stub.restore();
}

async function testBenignRedirectFollowed() {
    // The manual loop must still FOLLOW safe redirects — a posting moved
    // behind one 302 still resolves from the final response.
    const stub = installFetchMock([{
        matches: (u) => u.endsWith("/posting/x"),
        respond: () => respondRedirect("https://example.com/posting/x-final"),
    }, {
        matches: (u) => u.endsWith("/posting/x-final"),
        respond: () => respondStatus(200, "ok"),
    }]);
    const r = await probePostingLiveness({
        externalId: "x",
        sourceUrl: "https://example.com/posting/x",
    }, "careers-page");
    await expectResult(r, "alive", "benign 302 followed → final 200 → alive");
    if (stub.callCount() === 2) pass("benign redirect: exactly 2 fetches (hop + final)");
    else fail(`benign redirect: expected 2 fetches, got ${stub.callCount()}`);
    stub.restore();
}

// ─── P3.1c — MC_LIVENESS_BYPASS prod guard ────────────────────────────────

async function testBypassIgnoredOnProdTier() {
    const stub = installFetchMock([{
        matches: () => true,
        respond: () => respondStatus(200, "ok"),
    }]);
    try {
        process.env.MC_LIVENESS_BYPASS = "closed";
        process.env.MC_SCHEDULER_TIER = "prod";
        const results = await probeBatch(
            [{ externalId: "x", sourceUrl: "https://example.com/posting/x" }],
            "careers-page",
        );
        const verdict = results.get("x");
        if (verdict === "alive") pass("prod guard: MC_LIVENESS_BYPASS=closed ignored on MC_SCHEDULER_TIER=prod (real probe ran → alive)");
        else fail(`prod guard: expected real-probe 'alive', got '${verdict}' — bypass leaked into prod tier`);
        if (stub.callCount() >= 1) pass("prod guard: probe actually fetched (bypass did not short-circuit)");
        else fail("prod guard: no fetch issued — bypass was honored on prod tier");
    } finally {
        delete process.env.MC_LIVENESS_BYPASS;
        delete process.env.MC_SCHEDULER_TIER;
        stub.restore();
    }
}

async function testBypassHonoredOffProd() {
    // Sanity companion: with neither prod var set, the bypass still works —
    // the hermetic smokes that rely on it (scale regression etc.) depend on
    // this staying true.
    const stub = installFetchMock([{
        matches: () => true,
        respond: () => respondStatus(200, "ok"),
    }]);
    try {
        process.env.MC_LIVENESS_BYPASS = "closed";
        const results = await probeBatch(
            [{ externalId: "x", sourceUrl: "https://example.com/posting/x" }],
            "careers-page",
        );
        if (results.get("x") === "closed") pass("bypass off-prod: MC_LIVENESS_BYPASS=closed honored (no prod tier vars)");
        else fail(`bypass off-prod: expected 'closed', got '${results.get("x")}'`);
        if (stub.callCount() === 0) pass("bypass off-prod: zero fetches (short-circuited)");
        else fail(`bypass off-prod: expected 0 fetches, got ${stub.callCount()}`);
    } finally {
        delete process.env.MC_LIVENESS_BYPASS;
        stub.restore();
    }
}

// ─── probeBatch behavior ──────────────────────────────────────────────────

async function testBatchMaxPerTickOverflow() {
    // Pick a kind with a low cap so the test stays small.
    const kind: WatchlistKind = "careers-page";
    const cap = PROBE_PROFILES[kind].maxPerTick; // 50
    const inputs: ProbeInput[] = Array.from({ length: cap + 5 }, (_, i) => ({
        externalId: `e${i}`,
        sourceUrl: `https://example.com/x${i}`,
    }));
    const stub = installFetchMock([{
        matches: () => true,
        respond: () => respondStatus(200, "ok"),
    }]);
    const results = await probeBatch(inputs, kind);
    const aliveCount = [...results.values()].filter(v => v === "alive").length;
    const unknownCount = [...results.values()].filter(v => v === "unknown").length;
    if (aliveCount === cap && unknownCount === 5) pass(`probeBatch ${kind}: cap=${cap} → ${aliveCount} alive + ${unknownCount} unknown (overflow)`);
    else fail(`probeBatch ${kind} cap overflow: expected ${cap}/5 alive/unknown, got ${aliveCount}/${unknownCount}`);
    stub.restore();
}

async function testBatchConcurrencyCap() {
    // Greenhouse has concurrency=8, perHitDelayMs=0 → parallel mode.
    const kind: WatchlistKind = "greenhouse";
    const inputs: ProbeInput[] = Array.from({ length: 24 }, (_, i) => ({
        externalId: `e${i}`,
        sourceUrl: `https://job-boards.greenhouse.io/anthropic/jobs/${1000 + i}`,
    }));
    const stub = installFetchMock([{
        matches: () => true,
        // Each "request" waits 50ms so we can observe peak concurrency.
        respond: async () => {
            await new Promise(r => setTimeout(r, 50));
            return respondStatus(200, "ok");
        },
    }]);
    await probeBatch(inputs, kind);
    const peak = stub.inFlightPeak();
    const profile = PROBE_PROFILES[kind];
    if (peak <= profile.concurrency) pass(`probeBatch ${kind}: peak in-flight ${peak} ≤ profile.concurrency ${profile.concurrency}`);
    else fail(`probeBatch ${kind}: peak in-flight ${peak} > profile.concurrency ${profile.concurrency} — concurrency cap broken`);
    stub.restore();
}

async function testBatchPerHitDelay() {
    // LinkedIn: concurrency=1, perHitDelayMs=1500. Override delay to a small
    // value so the test runs quickly; assert delays are >= override between
    // consecutive starts.
    const kind: WatchlistKind = "linkedin";
    const inputs: ProbeInput[] = Array.from({ length: 3 }, (_, i) => ({
        externalId: `e${i}`,
        sourceUrl: `https://www.linkedin.com/jobs/view/test-${i}`,
    }));
    const stub = installFetchMock([{
        matches: () => true,
        respond: (u) => respond200(`<div class="top-card-layout">x</div>`, u),
    }]);
    const t0 = Date.now();
    await probeBatch(inputs, kind, { profile: { perHitDelayMs: 100 } });
    const elapsed = Date.now() - t0;
    // 3 probes × 100ms delay between each (2 sleeps) → at least 200ms.
    if (elapsed >= 200) pass(`probeBatch linkedin: per-hit delay enforced (elapsed ${elapsed}ms ≥ 200ms)`);
    else fail(`probeBatch linkedin: per-hit delay not enforced (elapsed ${elapsed}ms < 200ms)`);
    stub.restore();
}

async function testBatchSerialMode() {
    // Per-hit delay > 0 should force concurrency=1 effectively.
    const kind: WatchlistKind = "linkedin";
    const inputs: ProbeInput[] = Array.from({ length: 4 }, (_, i) => ({
        externalId: `e${i}`,
        sourceUrl: `https://www.linkedin.com/jobs/view/test-${i}`,
    }));
    const stub = installFetchMock([{
        matches: () => true,
        respond: async (u) => {
            await new Promise(r => setTimeout(r, 30));
            return respond200(`<div class="top-card-layout">x</div>`, u);
        },
    }]);
    await probeBatch(inputs, kind, { profile: { perHitDelayMs: 10 } });
    if (stub.inFlightPeak() === 1) pass("probeBatch linkedin: serial mode (peak in-flight = 1)");
    else fail(`probeBatch linkedin: expected serial mode, peak in-flight = ${stub.inFlightPeak()}`);
    stub.restore();
}

async function testBatchEmptyInput() {
    const r = await probeBatch([], "greenhouse");
    if (r.size === 0) pass("probeBatch: empty input → empty result");
    else fail(`probeBatch: empty input → got ${r.size} entries`);
}

async function testBatch429AbortsParallel() {
    // Greenhouse: concurrency=8, perHitDelayMs=0. Fixture: first probe 429s,
    // rest 404. After the 429, the abort flag must stop new fetches.
    //
    // What we DON'T assert: zero "closed" verdicts. Up to ~concurrency
    // probes may already be in-flight when the abort flag fires, and JS
    // scheduling can let workers loop into a 2nd round before any sees
    // the flag set. Their results are stored as-is — the contract is only
    // "no MORE fetches after abort", not "rewind already-completed ones".
    //
    // What we DO assert: every input has a verdict, and the total fetch
    // count is far below input count (abort worked).
    const kind: WatchlistKind = "greenhouse";
    const inputs: ProbeInput[] = Array.from({ length: 50 }, (_, i) => ({
        externalId: `e${i}`,
        sourceUrl: `https://job-boards.greenhouse.io/anthropic/jobs/${1000 + i}`,
    }));
    let serveCount = 0;
    const stub = installFetchMock([{
        matches: () => true,
        respond: async () => {
            const i = serveCount++;
            await new Promise(r => setTimeout(r, 50));
            if (i < 4) return respondStatus(429);
            return respondStatus(404);
        },
    }]);
    const results = await probeBatch(inputs, kind);
    if (results.size === inputs.length) {
        pass(`probeBatch 429-abort (parallel): every input got a verdict (${results.size}/${inputs.length})`);
    } else {
        fail(`probeBatch 429-abort (parallel): missing verdicts, got ${results.size}/${inputs.length}`);
    }
    // Generous upper bound: 2 rounds × concurrency (8) = 16 fetches max
    // before abort propagates. 50 - 16 = 34 inputs should short-circuit.
    if (stub.callCount() < inputs.length / 2) {
        pass(`probeBatch 429-abort (parallel): short-circuited (${stub.callCount()}/${inputs.length} fetches issued)`);
    } else {
        fail(`probeBatch 429-abort (parallel): expected <${inputs.length / 2} fetches after 429, got ${stub.callCount()}`);
    }
    stub.restore();
}

async function testBatch429AbortsSerial() {
    // LinkedIn: serial mode (concurrency=1, perHitDelayMs=1500 — overridden
    // below). First probe 429s, rest would 404. Abort must skip the rest.
    const kind: WatchlistKind = "linkedin";
    const inputs: ProbeInput[] = Array.from({ length: 5 }, (_, i) => ({
        externalId: `e${i}`,
        sourceUrl: `https://www.linkedin.com/jobs/view/test-${i}`,
    }));
    let serveCount = 0;
    const stub = installFetchMock([{
        matches: () => true,
        respond: () => {
            const i = serveCount++;
            return i === 0 ? respondStatus(429) : respondStatus(404);
        },
    }]);
    await probeBatch(inputs, kind, { profile: { perHitDelayMs: 10 } });
    if (stub.callCount() === 1) {
        pass("probeBatch 429-abort (serial): 1 fetch only — remaining probes short-circuited");
    } else {
        fail(`probeBatch 429-abort (serial): expected 1 fetch, got ${stub.callCount()}`);
    }
    stub.restore();
}

async function testUnsafeRedirectReturnsUnknown() {
    // Defense-in-depth: a source that 302s to an internal address (localhost,
    // RFC1918) must NOT produce a "closed" verdict via 404 on the internal
    // target. The post-fetch assertSafeResponseUrl check forces "unknown".
    const stub = installFetchMock([{
        matches: () => true,
        respond: () => {
            const res = new Response("internal 404 body", { status: 404 });
            Object.defineProperty(res, "url", { value: "http://127.0.0.1:9999/closed-404" });
            return res;
        },
    }]);
    const r = await probePostingLiveness({
        externalId: "x",
        sourceUrl: "https://example.com/posting/x",
    }, "careers-page");
    if (r === "unknown") pass("probeViaHttpStatus: redirect to internal host → unknown (assertSafeResponseUrl trip)");
    else fail(`probeViaHttpStatus: redirect-to-internal returned ${r} (expected unknown)`);
    stub.restore();
}

// ─── Sentinel: error path never returns "closed" ──────────────────────────

async function testNoFalseCloseOnError() {
    // Verify *every* exotic failure mode returns "unknown" — not "closed".
    // Catching this in case a future refactor flips the default.
    const kinds: WatchlistKind[] = Object.keys(PROBE_PROFILES) as WatchlistKind[];
    for (const kind of kinds) {
        const stub = installFetchMock([{
            matches: () => true,
            respond: () => { throw new Error("synthetic network failure"); },
        }]);
        const r = await probePostingLiveness({
            externalId: "x",
            sourceUrl: `https://example.com/${kind}/probe`,
        }, kind);
        if (r === "closed") fail(`${kind}: synthetic network failure returned 'closed' — DANGEROUS, would false-close`);
        else pass(`${kind}: synthetic failure → ${r} (not 'closed')`);
        stub.restore();
    }
}

async function main() {
    await testGenericStatusCodes();
    await testLinkedinAlive();
    await testLinkedinClosedRedirect();
    await testLinkedinClosedMarker();
    await testLinkedinAmbiguous();
    await testLinkedin404();
    await testGreenhouseUsesApi();
    await testLeverUsesApi();
    await testGreenhouseFallbackToSourceUrl();
    await testWorkdayLoginRedirect();
    await testWorkdayBoardRootRedirect();
    await testWorkdayAlive();
    await testAshbyBareRootRedirect();
    await testAuthInterstitialRedirectsUnknown();
    await testBoardSearchRootRedirectsClosed();
    await testOffPathBodyMarkerStillCloses();
    await testRedirectToPrivateIpBlocked();
    await testRedirectHopCapUnknown();
    await testBenignRedirectFollowed();
    await testBypassIgnoredOnProdTier();
    await testBypassHonoredOffProd();
    await testBatchMaxPerTickOverflow();
    await testBatchConcurrencyCap();
    await testBatchPerHitDelay();
    await testBatchSerialMode();
    await testBatchEmptyInput();
    await testBatch429AbortsParallel();
    await testBatch429AbortsSerial();
    await testUnsafeRedirectReturnsUnknown();
    await testNoFalseCloseOnError();

    console.log(`\n${passes}/${passes + fails} steps passed`);
    if (fails > 0) process.exit(1);
    console.log("All checks passed.");
}

main().catch((e) => {
    console.error("Unhandled error:", e);
    process.exit(1);
});
