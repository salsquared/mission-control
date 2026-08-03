/**
 * Hermetic regression smoke — ClearCompany's "200 for everything" SPA shell.
 *
 * THE BUG (fixed 2026-08-02). `<shortname>.clearcompany.com` serves an empty
 * client-rendered shell with HTTP 200 for EVERY job path. clearcompany was
 * wired to probeGeneric, which has no body check, so every probe returned
 * "alive" unconditionally: prod.db carried 245 clearcompany postings with ZERO
 * ever closed and `pendingClosedAt` never once stamped, 125 of them no longer
 * on the live board.
 *
 * Unlike Ashby, the shell is not merely hard to read — it is EMPTY. A live
 * posting, a 64-day-stale one and a syntactically bogus id all return the same
 * 11,027-byte body containing neither the job id nor the title, so no body
 * heuristic can ever discriminate. The fix is a structured probe of the public
 * detail API the board's own client uses:
 *
 *   GET https://careers-api.clearcompany.com/v1/<siteId>/<jobId>
 *
 * WHAT THIS FILE PINS. The standing risk in this module is mass-FALSE-CLOSE,
 * not under-closing (a confirmed close cascades into auto-closing linked
 * application cards and never self-heals), so both directions are asserted:
 *   - a removed / bogus posting resolves "closed"                (fix works)
 *   - a live posting resolves "alive"                            (fix is safe)
 *   - a BOARD-level 404 resolves "unknown", never "closed"       (interlock)
 *   - every ambiguous shape resolves "unknown", never "closed"
 *   - the probe never concludes from the SPA shell at all
 *
 * Fixtures are captured verbatim from live responses on 2026-08-02 (see
 * scripts/tests/debug/clearcompany-probe-audit.ts, which re-derives them). No
 * real network here.
 *
 *   DATABASE_URL="file:./dev.db" npx tsx scripts/tests/hermetic/clearcompany-liveness-smoke.ts
 */
import { unlinkSync } from "node:fs";
import { probePostingLiveness, PROBE_PROFILES, type LivenessResult } from "@/lib/postings/liveness";
import { __setUrlGuardResolver } from "@/lib/security/url-guard";

// Probes record their verdict to the fetcher-health store. Point it at a
// throwaway file BEFORE the first probe so the pre-push gate never writes
// fixture rows into the real data/fetcher-health.db.
const TMP_HEALTH_DB = `/tmp/clearcompany-liveness-smoke-health-${process.pid}-${Date.now()}.db`;
process.env.FETCHER_HEALTH_PATH = TMP_HEALTH_DB;
delete process.env.MC_LIVENESS_BYPASS;  // must exercise the REAL probe logic
delete process.env.MC_SCHEDULER_TIER;   // deterministic: web-process semantics

// Since 2026-08-02 the SSRF guard RESOLVES every hostname before allowing a
// fetch (lib/security/url-guard.ts layer 2), and this suite probes the real
// careers-api.clearcompany.com host. Stub the resolver so the suite stays
// hermetic — scripts/tests/hermetic/ must never depend on live DNS, or the
// pre-push gate stops working offline. Literal IP checks run BEFORE the
// resolver, so private-address assertions are unaffected.
__setUrlGuardResolver(() => [{ address: "93.184.216.34", family: 4 }]);

let passes = 0;
let fails = 0;
function pass(msg: string) { console.log(`[PASS] ${msg}`); passes++; }
function fail(msg: string, detail?: unknown) { console.error(`[FAIL] ${msg}`, detail ?? ""); fails++; }

// ─── Fixtures ─────────────────────────────────────────────────────────────

const SITE_ID = "00ed92c3-5bfb-7bfb-456d-4d9d77fef9a5";   // Firefly Aerospace
const LIVE_JOB = "d6db08ab-c00d-c94b-2d43-f8ab0ea513ca";
const GONE_JOB = "ec2951b8-ca42-288b-0608-3758b809938a";  // absent from the live board
const BOGUS_JOB = "00000000-0000-0000-0000-000000000000";

const liveUrl = (job: string) => `https://firefly.clearcompany.com/careers/jobs/${job}/apply`;

/** Real 200 payload, `description` trimmed. Note it echoes the requested id. */
const CC_LIVE_DETAIL = `{"id":"d6db08ab-c00d-c94b-2d43-f8ab0ea513ca","positionTitle":"GNC Engineer II, Hypersonics","description":"<h2>ABOUT FIREFLY AEROSPACE</h2> [trimmed for fixture]","openDate":"2026-07-23T00:00:00","postedDate":"2026-07-23T00:00:00","departmentId":"577D91AC-4C0E-4D06-4AF2-86FC01275AD8","departmentName":"Aerospace Software Engineering","officeId":"93342FDE-B491-6DFB-9826-DB223D22FDD2","officeName":"The Hive","location":"Cedar Park TX","locations":[{"city":"Cedar Park","subdivision":"TX","subdivisionFullName":"Texas","country":"US","postalCode":"78613","isRemote":false}],"brandName":"Firefly Aerospace","applyLink":"https://firefly.clearcompany.com/careers/jobs/d6db08ab-c00d-c94b-2d43-f8ab0ea513ca/apply","canSelfSchedule":false}`;

/**
 * POSTING-level 404 — the board exists, this requisition does not. Verbatim
 * (traceId varies per response). THIS is closure evidence.
 */
const CC_NOT_FOUND_PROBLEM = `{"type":"https://tools.ietf.org/html/rfc7231#section-6.5.4","title":"Not Found","status":404,"traceId":"00-0c0e06ae006ed8568b3a6a0fb40681b0-d2121b7e4201d1bd-00"}`;

/**
 * BOARD-level 404 — an unknown/rotated siteId never reaches the controller, so
 * the body is EMPTY. Reproduced against two different bogus siteIds. This is
 * the mass-false-close interlock: it must NEVER read as closure evidence.
 */
const CC_BOARD_NOT_FOUND_EMPTY = ``;

/**
 * The SPA shell that made the old probe useless. Trimmed from the real 11,027
 * bytes; the point is what it LACKS — no job id, no title, no posting field.
 */
const CC_SPA_SHELL = `<!DOCTYPE html>
<html class="en"><head><meta charset="utf-8" /><title></title></head>
<body>
  <div class="hrmHeader"><div class="hrmHeaderLogo"></div></div>
  <div id="content"></div>
  <script>
    window.appBase = window.location.protocol + "//" + window.location.hostname + "/";
    window.apiLocation = window.appBase + "api";
    window.$ccShortName = "firefly";
    window.appVersion = "1.0.9705.40079";
  </script>
</body></html>`;

// ─── Harness ──────────────────────────────────────────────────────────────

interface Capture { urls: string[]; restore: () => void }

/**
 * Serve a canned (status, body) for every request and record the URLs asked
 * for. Recording matters as much as the verdict here: a correct verdict reached
 * by hitting the SPA host instead of the API would be luck, not the design.
 */
function installMock(status: number, body: string): Capture {
    const original = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        urls.push(url);
        const res = new Response(body, { status, headers: { "content-type": "application/json" } });
        Object.defineProperty(res, "url", { value: url, writable: false });
        return res;
    }) as typeof fetch;
    return { urls, restore: () => { globalThis.fetch = original; } };
}

async function probe(
    status: number,
    body: string,
    opts: { job?: string; boardKey?: string | undefined; sourceUrl?: string } = {},
): Promise<{ verdict: LivenessResult; urls: string[] }> {
    const job = opts.job ?? LIVE_JOB;
    const mock = installMock(status, body);
    try {
        const verdict = await probePostingLiveness(
            {
                externalId: "x",
                sourceUrl: opts.sourceUrl ?? liveUrl(job),
                boardKey: "boardKey" in opts ? opts.boardKey : SITE_ID,
            },
            "clearcompany",
        );
        return { verdict, urls: mock.urls };
    } finally {
        mock.restore();
    }
}

async function expect(
    status: number,
    body: string,
    expected: LivenessResult,
    msg: string,
    opts: Parameters<typeof probe>[2] = {},
) {
    const { verdict } = await probe(status, body, opts);
    if (verdict === expected) pass(`${msg} → ${verdict}`);
    else fail(`${msg} — expected ${expected}, got ${verdict}`);
}

/** For ambiguous shapes the ONLY thing that matters is that we don't close. */
async function expectNotClosed(status: number, body: string, msg: string, opts: Parameters<typeof probe>[2] = {}) {
    const { verdict } = await probe(status, body, opts);
    if (verdict !== "closed") pass(`${msg} → ${verdict} (not closed)`);
    else fail(`${msg} — returned 'closed'; FALSE-CLOSE RISK`);
}

// ─── The regression, both directions ──────────────────────────────────────

async function testRemovedPostingCloses() {
    // Pre-fix these were "alive" — the entire bug.
    await expect(404, CC_NOT_FOUND_PROBLEM, "closed", "removed posting (404 + ProblemDetails)", { job: GONE_JOB });
    await expect(404, CC_NOT_FOUND_PROBLEM, "closed", "deliberately bogus job id", { job: BOGUS_JOB });
    // 410 is the other removal status probeViaHttpStatus recognises.
    await expect(410, CC_NOT_FOUND_PROBLEM, "closed", "removed posting via 410", { job: GONE_JOB });
}

async function testLivePostingStaysAlive() {
    await expect(200, CC_LIVE_DETAIL, "alive", "live posting (200, payload echoes the requested id)");
}

/**
 * The probe must interrogate the API, not the tenant's SPA host. If it ever
 * regressed to fetching the posting page, every verdict would be "alive" again
 * (200-for-everything) and the assertions above would still pass on a mock
 * that ignores the URL.
 */
async function testProbesTheApiNotTheShell() {
    const { urls } = await probe(200, CC_LIVE_DETAIL);
    if (urls.length !== 1) {
        fail(`expected exactly 1 request per probe, got ${urls.length}: ${urls.join(", ")}`);
        return;
    }
    const u = urls[0];
    const expected = `https://careers-api.clearcompany.com/v1/${SITE_ID}/${LIVE_JOB}`;
    if (u === expected) pass(`probe hits the structured detail API (${u})`);
    else fail(`probe requested the wrong URL — expected ${expected}, got ${u}`);
    if (!u.includes("firefly.clearcompany.com")) pass("probe never touches the tenant SPA host");
    else fail("probe touched the tenant SPA host — that host answers 200 for everything");
}

// ─── Anti-false-close interlocks ──────────────────────────────────────────

async function testBoardLevelNotFoundNeverCloses() {
    // THE interlock. An unknown/rotated siteId 404s with an EMPTY body. Closing
    // on it would take out every posting on the board at once, and false-closed
    // rows never self-heal (the stale re-probe excludes status="closed", the C3
    // sweep selects only status="new"; recovery is a manual script).
    await expect(
        404, CC_BOARD_NOT_FOUND_EMPTY, "unknown",
        "interlock: BOARD-level 404 (empty body — bad/rotated siteId)",
    );
    // Whitespace-only is the same thing.
    await expect(404, "   \n  ", "unknown", "interlock: board-level 404 with whitespace-only body");
}

async function testMissingBoardKeyNeverConcludes() {
    // Callers with no watchlist config in hand (recover-false-closed.ts, the
    // audit probe) pass no boardKey. That must be inert, in BOTH directions:
    // not "closed" (nothing was proven) and not "alive" (which would refresh
    // lastSeenAt and mask a genuinely dead posting).
    for (const [status, body, label] of [
        [200, CC_LIVE_DETAIL, "live payload"],
        [404, CC_NOT_FOUND_PROBLEM, "not-found payload"],
    ] as Array<[number, string, string]>) {
        const { verdict, urls } = await probe(status, body, { boardKey: undefined });
        if (verdict === "unknown") pass(`no boardKey (${label}) → unknown`);
        else fail(`no boardKey (${label}) → expected unknown, got ${verdict}`);
        if (urls.length === 0) pass(`no boardKey (${label}) → zero network requests`);
        else fail(`no boardKey (${label}) → issued ${urls.length} request(s); should short-circuit`);
    }
}

async function testNonCanonicalUrlNeverConcludes() {
    for (const sourceUrl of [
        "https://firefly.clearcompany.com/careers/",            // board root, no job id
        "https://firefly.clearcompany.com/careers/jobs/",       // no job id
        "https://example.com/careers/jobs/abcdef1234567890/apply", // wrong host
        "not a url at all",
    ]) {
        const { verdict, urls } = await probe(404, CC_NOT_FOUND_PROBLEM, { sourceUrl });
        if (verdict === "unknown") pass(`non-canonical URL → unknown (${sourceUrl.slice(0, 52)})`);
        else fail(`non-canonical URL ${sourceUrl} → expected unknown, got ${verdict}`);
        if (urls.length > 0) fail(`non-canonical URL ${sourceUrl} issued ${urls.length} request(s)`);
    }
}

async function testIdEchoRequiredForAlive() {
    // A 200 whose payload is some OTHER requisition (or no requisition) must not
    // read as this posting being live.
    const otherJob = CC_LIVE_DETAIL.replace(LIVE_JOB, "ffffffff-ffff-ffff-ffff-ffffffffffff");
    await expect(200, otherJob, "unknown", "interlock: 200 echoing a DIFFERENT job id");
    await expect(200, `{}`, "unknown", "interlock: 200 with an empty JSON envelope");
    await expect(200, `{"results":[],"totalCount":0}`, "unknown", "interlock: 200 with a board LIST payload");
    await expect(200, ``, "unknown", "interlock: 200 with an empty body");
    // The shell itself, in case a redirect ever lands the API request on it.
    await expect(200, CC_SPA_SHELL, "unknown", "interlock: 200 serving the empty SPA shell");
}

/**
 * The shell fixture is this repo's only record of WHY no body heuristic can
 * work here. If it ever gained the job id or the title, the premise behind the
 * structured probe would have changed and someone should re-read the design.
 */
async function testShellFixtureStillCarriesNoPostingData() {
    const lower = CC_SPA_SHELL.toLowerCase();
    const leaks = [LIVE_JOB, "gnc engineer", "positiontitle"].filter(s => lower.includes(s.toLowerCase()));
    if (leaks.length === 0) {
        pass("SPA shell fixture still contains no job id / title / posting field");
    } else {
        fail(
            `SPA shell fixture now contains posting data (${leaks.join(", ")}). The premise of ` +
            `probeClearCompany — that the shell is undiscriminating — may no longer hold; re-read its note.`,
        );
    }
}

async function testRefusalsNeverClose() {
    // A source refusing us is never evidence about a posting.
    for (const status of [403, 429, 500, 503]) {
        await expectNotClosed(status, `{"error":"nope"}`, `refusal ${status}`);
    }
    // ...and 400/401 (a malformed or unauthenticated request) are our bug, not
    // a removal.
    for (const status of [400, 401]) {
        await expectNotClosed(status, `{"Message":"Unknown or missing API-ShortName header value."}`, `client error ${status}`);
    }
}

// ─── Probe budget ─────────────────────────────────────────────────────────

/**
 * probeClearCompany hits careers-api.clearcompany.com — the SAME host the job
 * LIST crawl uses — so an over-hot profile starves the crawl that actually
 * finds jobs. Pin the politeness rather than the exact numbers' rationale.
 */
async function testProfileIsPolite() {
    const p = PROBE_PROFILES.clearcompany;
    if (p.perHitDelayMs > 0) pass(`profile: perHitDelayMs=${p.perHitDelayMs} > 0 (serial mode — shares a host with the crawl)`);
    else fail("profile: perHitDelayMs must be > 0 so probeBatch runs serially against the shared API host");
    if (p.maxPerTick <= 60) pass(`profile: maxPerTick=${p.maxPerTick} ≤ 60`);
    else fail(`profile: maxPerTick=${p.maxPerTick} is too hot for the shared API host`);
}

async function main() {
    await testRemovedPostingCloses();
    await testLivePostingStaysAlive();
    await testProbesTheApiNotTheShell();
    await testBoardLevelNotFoundNeverCloses();
    await testMissingBoardKeyNeverConcludes();
    await testNonCanonicalUrlNeverConcludes();
    await testIdEchoRequiredForAlive();
    await testShellFixtureStillCarriesNoPostingData();
    await testRefusalsNeverClose();
    await testProfileIsPolite();

    await cleanupTempHealthDb();

    console.log(`\n${passes}/${passes + fails} steps passed`);
    if (fails > 0) process.exit(1);
    console.log("All checks passed.");
}

/** Close the throwaway health store and remove its files (incl. WAL sidecars). */
async function cleanupTempHealthDb() {
    try {
        const health = await import("@/lib/fetcher-health/store");
        await health._resetFetcherHealthForTests(); // close before unlinking
    } catch { /* store may never have initialized */ }
    for (const suffix of ["", "-wal", "-shm"]) {
        try { unlinkSync(`${TMP_HEALTH_DB}${suffix}`); } catch { /* may not exist */ }
    }
}

main().catch(async (e) => {
    await cleanupTempHealthDb();
    console.error("Unhandled error:", e);
    process.exit(1);
});
