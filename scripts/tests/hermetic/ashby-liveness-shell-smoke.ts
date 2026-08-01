/**
 * Hermetic regression smoke — Ashby's "200 for everything" not-found shell.
 *
 * THE BUG (fixed 2026-08-01). jobs.ashbyhq.com never 404s: a live posting, a
 * removed posting, and a posting under an organization that no longer exists
 * ALL answer HTTP 200. `ASHBY_ALIVE_MARKERS` led with `"window.__appdata"`, and
 * the ~7KB not-found shell embeds that blob too (every field null) — so the
 * marker had zero discriminating power and the alive-gate matched it on every
 * dead page. Every removed Ashby posting probed "alive" forever. Measured on
 * prod.db at the time: ashby had closed 1 of 373 postings (0.3%), against
 * greenhouse 2694/6151 (43.8%) and lever 73/205 (35.6%).
 *
 * WHY THIS FILE EXISTS SEPARATELY from liveness-probe-smoke.ts (which already
 * covers Ashby's board-root redirect) and from watchlist-closed-detection-smoke
 * .ts (which covers the close STATE MACHINE under MC_LIVENESS_BYPASS): the
 * bypass deliberately short-circuits probeBatch before any body is parsed, so
 * neither of those exercises marker matching. This one drives the real
 * probeAshby body logic against fixtures captured verbatim from live responses
 * on 2026-08-01 (three fetches: a live posting, a dead org, and a bogus posting
 * id under a live org).
 *
 * It asserts BOTH directions, because the standing risk in this module is
 * mass-FALSE-CLOSE, not under-closing:
 *   - the dead all-null shell now resolves "closed"        (the fix works)
 *   - a live server-rendered posting still resolves "alive" (the fix is safe)
 *   - every near-miss body resolves "unknown", never "closed"
 *
 *   DATABASE_URL="file:./dev.db" npx tsx scripts/tests/hermetic/ashby-liveness-shell-smoke.ts
 *
 * Pure logic — no DB writes, no real network.
 */
import { unlinkSync } from "node:fs";
import { probePostingLiveness, type LivenessResult } from "@/lib/postings/liveness";

// Probes record their verdict to the fetcher-health store. Point it at a
// throwaway file BEFORE the first probe so the pre-push gate never writes
// fixture rows into the real data/fetcher-health.db (the store reads this env
// var lazily at init, so setting it here is early enough).
const TMP_HEALTH_DB = `/tmp/ashby-liveness-shell-smoke-health-${process.pid}-${Date.now()}.db`;
process.env.FETCHER_HEALTH_PATH = TMP_HEALTH_DB;
delete process.env.MC_LIVENESS_BYPASS;  // must exercise the REAL body logic
delete process.env.MC_SCHEDULER_TIER;   // deterministic: web-process semantics

let passes = 0;
let fails = 0;
function pass(msg: string) { console.log(`[PASS] ${msg}`); passes++; }
function fail(msg: string, detail?: unknown) { console.error(`[FAIL] ${msg}`, detail ?? ""); fails++; }

// ─── Fixtures ─────────────────────────────────────────────────────────────
//
// Captured verbatim from jobs.ashbyhq.com on 2026-08-01. The surrounding HTML
// is trimmed to the structural bits that matter (the real shell is 7,079 bytes
// and the real live page 48,861); every string the probe keys on is unmodified.

/**
 * The not-found shell. This exact blob was returned for BOTH
 * `/cosmos/<uuid>` (organization gone) and `/ashby/<bogus-uuid>` (organization
 * very much alive, posting id nonexistent) — the two bodies were byte-identical
 * apart from the per-response CSP nonce. That second case is the one that
 * matters operationally: it is what a posting removed from a still-active board
 * looks like, i.e. the bulk of the 373.
 */
const ASHBY_NOT_FOUND_SHELL = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Jobs</title></head>
<body>
  <noscript>You need to enable JavaScript to run this app.</noscript>
  <div id="root"><div class="center"><div class="fade-in"><div class="spinner"></div></div></div></div>
  <script nonce="4U71fcdPzkSkQK8kdV0QWWfO6Xm65Qo_ifaJUNMsM8M">
    window.__appData = {"ddRumApplicationId":"80e0bf43-e772-45ac-858b-1e6dc0f1f415","ddRumClientToken":"pub1a87c7036063ee7d4b7914b397e6324e","environment":"production","maintenanceMode":false,"schedulingMaintenanceMode":false,"organization":null,"posting":null,"jobBoard":null,"routerPrefix":"/","recaptchaPublicSiteKey":"6LeFb_YUAAAAALUD5h-BiQEp8JaFChe0e0A6r49Y","customDomainData":null};
  </script>
</body></html>`;

/**
 * A live, server-rendered posting. Note `organization` and `posting` are
 * hydrated objects and the posting carries `"isListed":true` — the real alive
 * signal. `"jobBoard":null` is present here TOO, which is why the fix treats it
 * as a shape assertion rather than evidence.
 */
const ASHBY_LIVE_POSTING = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Commercial Counsel</title></head>
<body>
  <div id="root"><h1>Commercial Counsel</h1></div>
  <script>
    window.__appData = {"ddRumApplicationId":"80e0bf43-e772-45ac-858b-1e6dc0f1f415","environment":"production","maintenanceMode":false,"organization":{"organizationId":"4ea5f68e-c33e-4ac9-831a-e732bee4a303","name":"Ashby","publicWebsite":"https://www.ashbyhq.com","hostedJobsPageSlug":"Ashby","applicationFormDefinition":{"showCookieBanner":false}},"posting":{"id":"4a855fbc-aac7-46ff-bffd-0668abf6c339","title":"Commercial Counsel","departmentName":"Legal","locationName":"Remote - US","workplaceType":"Remote","isListed":true,"isConfidential":false,"employmentType":"FullTime","descriptionHtml":"<p>Ashby is building the next generation of hiring software.</p>"},"jobBoard":null,"routerPrefix":"/","customDomainData":null};
  </script>
</body></html>`;

/** Live posting URL shape: jobs.ashbyhq.com/<org-slug>/<posting-uuid>. */
const LIVE_URL = "https://jobs.ashbyhq.com/ashby/4a855fbc-aac7-46ff-bffd-0668abf6c339";
const DEAD_ORG_URL = "https://jobs.ashbyhq.com/cosmos/d1281df3-ed30-41cb-a75e-c920e3a16305";
const DEAD_POSTING_URL = "https://jobs.ashbyhq.com/ashby/00000000-0000-0000-0000-000000000000";

// ─── Harness ──────────────────────────────────────────────────────────────

interface InstalledMock { callCount: () => number; restore: () => void }

/** Serve `body` as a 200 for any URL, with response.url set to the request URL. */
function installBodyMock(body: string): InstalledMock {
    const original = globalThis.fetch;
    let callCount = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
        callCount++;
        const url = typeof input === "string" ? input : input.toString();
        const res = new Response(body, { status: 200, headers: { "content-type": "text/html" } });
        Object.defineProperty(res, "url", { value: url, writable: false });
        return res;
    }) as typeof fetch;
    return { callCount: () => callCount, restore: () => { globalThis.fetch = original; } };
}

async function probeBody(body: string, sourceUrl = LIVE_URL): Promise<LivenessResult> {
    const stub = installBodyMock(body);
    try {
        return await probePostingLiveness({ externalId: "x", sourceUrl }, "ashby");
    } finally {
        stub.restore();
    }
}

async function expectVerdict(body: string, sourceUrl: string, expected: LivenessResult, msg: string) {
    const actual = await probeBody(body, sourceUrl);
    if (actual === expected) pass(`${msg} → ${actual}`);
    else fail(`${msg} — expected ${expected}, got ${actual}`);
}

/** For near-miss bodies the ONLY thing that matters is that we don't close. */
async function expectNotClosed(body: string, msg: string) {
    const actual = await probeBody(body);
    if (actual !== "closed") pass(`${msg} → ${actual} (not closed)`);
    else fail(`${msg} — returned 'closed'; FALSE-CLOSE RISK`);
}

// ─── The regression, both directions ──────────────────────────────────────

async function testDeadShellClosesBothCases() {
    // Pre-fix these were "alive" — the entire bug.
    await expectVerdict(
        ASHBY_NOT_FOUND_SHELL, DEAD_ORG_URL, "closed",
        "dead shell / organization gone (cosmos)",
    );
    // The operationally important one: org still exists, posting removed.
    await expectVerdict(
        ASHBY_NOT_FOUND_SHELL, DEAD_POSTING_URL, "closed",
        "dead shell / live org + removed posting",
    );
}

async function testLivePostingStaysAlive() {
    await expectVerdict(
        ASHBY_LIVE_POSTING, LIVE_URL, "alive",
        "live server-rendered posting (organization+posting hydrated, isListed:true)",
    );
}

async function testRetiredMarkerNoLongerGrantsAlive() {
    // The removed marker in isolation. A body carrying only the blob anchor —
    // no nulls, no isListed — is shape drift: it must fall to "unknown", NOT
    // "alive" (pre-fix) and NOT "closed" (over-correction).
    const driftBody = `<html><body><div id="root"></div><script>
      window.__appData = {"environment":"production","maintenanceMode":false,"routerPrefix":"/"};
    </script></body></html>`;
    const actual = await probeBody(driftBody);
    if (actual === "unknown") {
        pass("blob anchor alone (no nulls, no isListed) → unknown (retired marker no longer implies alive)");
    } else {
        fail(`blob anchor alone → expected unknown, got ${actual}`);
    }
}

// ─── Anti-false-close interlocks ──────────────────────────────────────────

async function testInterlocksNeverClose() {
    // Each of these satisfies SOME of the shell conditions. None may close.
    const hydratedOrgWithStrayNulls = ASHBY_NOT_FOUND_SHELL.replace(
        `"organization":null`,
        `"organization":{"organizationId":"4ea5f68e","name":"Ashby"}`,
    );
    await expectNotClosed(
        hydratedOrgWithStrayNulls,
        "interlock: posting+jobBoard null but organization HYDRATED",
    );

    const shellPlusIsListed = ASHBY_NOT_FOUND_SHELL.replace(
        `"customDomainData":null`,
        `"customDomainData":null,"debug":{"isListed":true}`,
    );
    await expectNotClosed(
        shellPlusIsListed,
        "interlock: all-null shell that ALSO claims isListed:true",
    );

    // Anchor requirement: three nulls in some unrelated JSON island, no
    // window.__appData at all — e.g. a CDN error page or a different SPA.
    const noAnchor = `<html><body><script>
      var state = {"organization":null,"posting":null,"jobBoard":null};
    </script></body></html>`;
    await expectNotClosed(noAnchor, "interlock: three nulls but NO window.__appData anchor");

    // Partial shell — only `posting` null. Ashby hydrating the org but not the
    // posting is precisely the shape a future rendering change could produce.
    const partial = `<html><body><script>
      window.__appData = {"organization":{"name":"Ashby"},"posting":null,"jobBoard":null};
    </script></body></html>`;
    await expectNotClosed(partial, "interlock: partial shell (organization hydrated, posting null)");

    // A live posting body must survive even if a description quotes a null.
    const liveWithStrayNull = ASHBY_LIVE_POSTING.replace(
        `<p>Ashby is building the next generation of hiring software.</p>`,
        `<p>Our stack returns \\"organization\\":null for unknown tenants.</p>`,
    );
    await expectNotClosed(liveWithStrayNull, "interlock: live posting whose description quotes a null literal");
}

// ─── Pre-existing Ashby behavior must be preserved ────────────────────────

async function testExistingSignalsPreserved() {
    // The tier-4 unlisted flag still closes.
    const unlisted = ASHBY_LIVE_POSTING.replace(`"isListed":true`, `"isListed":false`);
    await expectVerdict(unlisted, LIVE_URL, "closed", "preserved: isListed:false");

    // A rendered closure banner still closes.
    const banner = `<html><body><div id="root">
      <h1>This job posting is no longer available</h1></div>
      <script>window.__appData = {"organization":{"name":"Acme"},"posting":null,"jobBoard":null};</script>
    </body></html>`;
    await expectVerdict(banner, LIVE_URL, "closed", "preserved: rendered closure banner");

    // Redirect to the bare board root (fewer than 2 path segments) still closes.
    const stub = (() => {
        const original = globalThis.fetch;
        globalThis.fetch = (async () => {
            const res = new Response("board page", { status: 200 });
            Object.defineProperty(res, "url", { value: "https://jobs.ashbyhq.com/ashby" });
            return res;
        }) as typeof fetch;
        return () => { globalThis.fetch = original; };
    })();
    const r = await probePostingLiveness({ externalId: "x", sourceUrl: LIVE_URL }, "ashby");
    stub();
    if (r === "closed") pass("preserved: redirect to bare board root → closed");
    else fail(`preserved: bare board root expected closed, got ${r}`);

    // A refusal is never closure evidence.
    for (const status of [403, 429, 500]) {
        const original = globalThis.fetch;
        globalThis.fetch = (async () => new Response("", { status })) as typeof fetch;
        const v = await probePostingLiveness({ externalId: "x", sourceUrl: LIVE_URL }, "ashby");
        globalThis.fetch = original;
        if (v === "unknown") pass(`preserved: ashby ${status} refusal → unknown (never closed)`);
        else fail(`preserved: ashby ${status} returned ${v}, expected unknown`);
    }
}

async function main() {
    await testDeadShellClosesBothCases();
    await testLivePostingStaysAlive();
    await testRetiredMarkerNoLongerGrantsAlive();
    await testInterlocksNeverClose();
    await testExistingSignalsPreserved();

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
