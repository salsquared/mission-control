/**
 * Hermetic regression smoke — a SPORADIC 403 must not black out a whole tenant,
 * while a DETERMINISTIC 403 must still stop us cold.
 *
 * THE BUG (fixed 2026-08-02). One refusal anywhere in a probeBatch tick flipped
 * the shared abort flag, so with `maxPerTick: 60` a single 403 discarded ~59
 * probes; the same refusal also counted a full strike toward the per-tenant CXS
 * breaker, and three of those parked the tenant for six hours with zero network
 * activity. Measured live the same day, on two Workday tenants whose behaviour
 * is genuinely different and which the old code could not tell apart:
 *
 *   Blue Origin (wd5) — SPORADIC. Its CXS detail endpoint WORKS: one run of 10
 *     sequential probes returned 200 ten times out of ten, and an earlier
 *     back-to-back burst of 12 returned 8× 200 / 4× 403. The 403 is
 *     intermittent, load-shaped and self-recovering. Yet close-detection was
 *     fully dark for its 1,621 postings, the live log reading
 *     `candidates=922 alive=1 unknown=921` — one probe succeeded and then our
 *     OWN back-off ended the tick. The outage was entirely self-inflicted.
 *
 *   Boeing / Maxar / Axiom (wd1) — DETERMINISTIC. `403 {"errorCode":"S22",
 *     "httpStatus":403,"message":"permission denied"}` on EVERY request; Boeing
 *     returned it 6 of 6 at one request per second, far below any plausible
 *     rate limit. Tenant configuration, not throttling. Nothing will ever
 *     produce a verdict here, so the breaker is correct and valuable.
 *
 * WHAT THIS FILE PINS — the property, not the plumbing:
 *   - a 403 that clears on retry yields a REAL verdict, does not abort the
 *     batch, and does not advance the CXS breaker;
 *   - a 403 that never clears still ends "unknown", still aborts the batch, and
 *     still parks the tenant — just a few requests later;
 *   - the extra request volume is BOUNDED, and the bound is asserted. Getting
 *     this wrong re-creates the 2026-07-31 incident, where probe traffic ran 9×
 *     the actual crawl volume and IP-blocked Axiom Space's own crawl for 15
 *     days;
 *   - 429 and 5xx are NOT retried and still abort on sight (the protection that
 *     already existed is not weakened to buy the above);
 *   - no refusal, retried or not, ever produces "closed".
 *
 * WHY globalThis.fetch IS STUBBED rather than a local fixture server being spun
 * up: probeViaHttpStatus runs `assertExternalHttpUrl` on its target before the
 * first byte, and that guard refuses loopback and RFC1918 addresses (it is the
 * SSRF interlock — see testRedirectToPrivateIpBlocked in liveness-probe-smoke
 * .ts). A real http://127.0.0.1 fixture would be rejected before any request
 * was made, so stubbing fetch is the only way to exercise this module at all.
 * The sibling liveness smokes do the same.
 *
 *   DATABASE_URL="file:./dev.db" npx tsx scripts/tests/hermetic/liveness-refusal-retry-smoke.ts
 *
 * Pure logic — no DB writes, no real network.
 */
import { unlinkSync } from "node:fs";
import {
    probePostingLiveness,
    probeBatch,
    PROBE_PROFILES,
    _resetWorkdayCxsBreakerForTests,
    _setSoftRefusalBackoffForTests,
    type LivenessResult,
    type ProbeInput,
    type WatchlistKind,
} from "@/lib/postings/liveness";
import { __setUrlGuardResolver } from "@/lib/security/url-guard";

// Probes record their verdict to the fetcher-health store. Point it at a
// throwaway file BEFORE the first probe so the pre-push gate never writes
// fixture rows into the real data/fetcher-health.db.
const TMP_HEALTH_DB = `/tmp/liveness-refusal-retry-smoke-health-${process.pid}-${Date.now()}.db`;
process.env.FETCHER_HEALTH_PATH = TMP_HEALTH_DB;
delete process.env.MC_LIVENESS_BYPASS;  // must exercise the REAL probe logic
delete process.env.MC_SCHEDULER_TIER;   // deterministic: web-process semantics

// Since 2026-08-02 the SSRF guard RESOLVES every hostname before allowing a
// fetch (lib/security/url-guard.ts layer 2), and this suite's fixtures are real
// third-party hostnames (*.myworkdayjobs.com, job-boards.greenhouse.io). Stub
// the resolver so the suite stays hermetic — scripts/tests/hermetic/ must never
// depend on live DNS, or the pre-push gate stops working offline. Literal IP
// checks run BEFORE the resolver, so private-address assertions are unaffected.
__setUrlGuardResolver(() => [{ address: "93.184.216.34", family: 4 }]);

/**
 * The real backoff is 300ms→600ms jittered. This file drives the retry path
 * ~150 times; at the real numbers that is well over a minute added to every
 * push for zero extra signal, since every assertion here is on request COUNTS
 * and verdicts. The one section that cares about wall-clock (the timeout-budget
 * tests) sets its own value and restores this afterwards.
 */
const FAST_BACKOFF_MS = 2;
_setSoftRefusalBackoffForTests(FAST_BACKOFF_MS);

let passes = 0;
let fails = 0;
function pass(msg: string) { console.log(`[PASS] ${msg}`); passes++; }
function fail(msg: string, detail?: unknown) { console.error(`[FAIL] ${msg}`, detail ?? ""); fails++; }

function check(cond: boolean, okMsg: string, badMsg: string) {
    if (cond) pass(okMsg); else fail(badMsg);
}

// ─── Fixtures ─────────────────────────────────────────────────────────────

/** Boeing's verbatim deterministic refusal body. */
const CXS_PERMISSION_DENIED = `{"errorCode":"S22","errorCaseId":"9d1f4b0e","httpStatus":403,"message":"permission denied"}`;
/** A live Workday CXS detail payload, trimmed to the tier-4 flag the probe reads. */
const CXS_LIVE = `{"jobPostingInfo":{"posted":true,"canApply":true,"title":"Engineer"}}`;
/** The client-rendered SPA shell modern Workday tenants serve for the HTML fallback. */
const WORKDAY_SPA_SHELL = `<html><body><div id="root"></div></body></html>`;

/** Workday posting URL for tenant `t`, posting `n`. */
const wdUrl = (t: string, dc: string, site: string, n: number) =>
    `https://${t}.${dc}.myworkdayjobs.com/en-US/${site}/job/Somewhere/Engineer-${n}_R${n}`;
const blueOrigin = (n: number) => wdUrl("blueorigin", "wd5", "BlueOrigin", n);
const boeing = (n: number) => wdUrl("boeing", "wd1", "EXTERNAL_CAREERS", n);

const isCxs = (url: string) => url.includes("/wday/cxs/");

// ─── Harness ──────────────────────────────────────────────────────────────

type Reply =
    | { status: number; body?: string; delayMs?: number }
    /** Never answers — exercises the per-attempt AbortSignal / timeout path. */
    | "hang";

interface Recorder {
    total: () => number;
    urls: () => string[];
    /** ms since the fixture was installed, one per request, in dispatch order. */
    times: () => number[];
    count: (pred: (url: string) => boolean) => number;
    restore: () => void;
}

function abortError(): Error {
    const e = new Error("The operation was aborted.");
    e.name = "AbortError";
    return e;
}

/** Sleep that rejects the moment the probe's AbortSignal fires. */
function abortableDelay(ms: number, signal: AbortSignal | null | undefined): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) { reject(abortError()); return; }
        const t = setTimeout(resolve, ms);
        signal?.addEventListener("abort", () => { clearTimeout(t); reject(abortError()); }, { once: true });
    });
}

/**
 * Stub `fetch` with a plan keyed on (url, nth-request-for-that-url). The
 * per-URL attempt counter is what lets a fixture say "refuse the first attempt,
 * answer the second" — i.e. model Blue Origin's sporadic 403 exactly, per
 * posting, without depending on Math.random.
 */
function installFetch(plan: (url: string, nth: number) => Reply): Recorder {
    const original = globalThis.fetch;
    const seen = new Map<string, number>();
    const urls: string[] = [];
    const times: number[] = [];
    const t0 = Date.now();
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        urls.push(url);
        times.push(Date.now() - t0);
        const nth = (seen.get(url) ?? 0) + 1;
        seen.set(url, nth);
        const reply = plan(url, nth);
        const signal = init?.signal ?? null;
        if (reply === "hang") {
            // 30s is comfortably longer than any timeoutMs used here; the
            // AbortSignal is what actually ends it, and the timer is cleared on
            // abort so nothing keeps the process alive.
            await abortableDelay(30_000, signal);
            throw new Error("fixture hang timer elapsed — a probe outlived its budget by 30s");
        }
        if (reply.delayMs) await abortableDelay(reply.delayMs, signal);
        const res = new Response(reply.body ?? "", {
            status: reply.status,
            headers: { "content-type": "application/json" },
        });
        Object.defineProperty(res, "url", { value: url, writable: false });
        return res;
    }) as typeof fetch;
    return {
        total: () => urls.length,
        urls: () => urls,
        times: () => times,
        count: (pred) => urls.filter(pred).length,
        restore: () => { globalThis.fetch = original; },
    };
}

/** Run `fn` with a stubbed fetch and a cleared CXS breaker; always restores. */
async function withFixture<T>(
    plan: (url: string, nth: number) => Reply,
    fn: (rec: Recorder) => Promise<T>,
): Promise<T> {
    _resetWorkdayCxsBreakerForTests();
    const rec = installFetch(plan);
    try {
        return await fn(rec);
    } finally {
        rec.restore();
        _resetWorkdayCxsBreakerForTests();
    }
}

const verdictCounts = (m: Map<string, LivenessResult>) => ({
    alive: [...m.values()].filter(v => v === "alive").length,
    closed: [...m.values()].filter(v => v === "closed").length,
    unknown: [...m.values()].filter(v => v === "unknown").length,
});

// ─── 1. The sporadic case — a retried 403 reaches a real verdict ──────────

async function testSporadicRefusalRecoversToAVerdict() {
    // Blue Origin's shape: attempt 1 refuses, attempt 2 answers. Pre-fix this
    // probe returned "unknown", fired onRateLimit, and took the tick with it.
    await withFixture((url, nth) => {
        if (!isCxs(url)) return { status: 200, body: WORKDAY_SPA_SHELL };
        return nth === 1 ? { status: 403, body: CXS_PERMISSION_DENIED } : { status: 200, body: CXS_LIVE };
    }, async (rec) => {
        const r = await probePostingLiveness({ externalId: "x", sourceUrl: blueOrigin(1) }, "workday");
        check(r === "alive", "sporadic: 403 then 200 → alive (a real verdict, not 'unknown')",
            `sporadic: expected alive, got ${r}`);
        check(rec.total() === 2, "sporadic: cost exactly 2 requests (1 refused + 1 retry)",
            `sporadic: expected 2 requests, got ${rec.total()}`);
    });

    // Two refusals then an answer — still inside the budget of 3 attempts.
    await withFixture((url, nth) => {
        if (!isCxs(url)) return { status: 200, body: WORKDAY_SPA_SHELL };
        return nth <= 2 ? { status: 403, body: CXS_PERMISSION_DENIED } : { status: 200, body: CXS_LIVE };
    }, async (rec) => {
        const r = await probePostingLiveness({ externalId: "x", sourceUrl: blueOrigin(2) }, "workday");
        check(r === "alive", "sporadic: 403, 403, 200 → alive (both retries used)",
            `sporadic (two refusals): expected alive, got ${r}`);
        check(rec.total() === 3, "sporadic: cost exactly 3 requests (the documented per-probe ceiling)",
            `sporadic (two refusals): expected 3 requests, got ${rec.total()}`);
    });

    // A retry can also recover a CLOSED verdict — the retry is about reaching
    // evidence, not about preferring "alive".
    //
    // WORTH SAYING OUT LOUD: this is genuinely NEW reachability. Before the
    // retry, a probe whose first attempt was refused could only ever return
    // "unknown", so no 403-then-404 sequence could produce a close. It is a
    // deliberate consequence, not an accident, and it is contained by
    // job-watcher's two-strike rule (scheduler/jobs/job-watcher.ts): one
    // "closed" verdict only stamps `pendingClosedAt`, and the confirm needs a
    // second closed verdict on a LATER tick inside the MIN/MAX_PENDING_CLOSED
    // _AGE_MS window. So a single retry-recovered 404 never closes a row on its
    // own — which is what makes widening reachability here safe.
    await withFixture((url, nth) => {
        if (!isCxs(url)) return { status: 200, body: WORKDAY_SPA_SHELL };
        return nth === 1 ? { status: 403, body: CXS_PERMISSION_DENIED } : { status: 404 };
    }, async () => {
        const r = await probePostingLiveness({ externalId: "x", sourceUrl: blueOrigin(3) }, "workday");
        check(r === "closed", "sporadic: 403 then 404 → closed (retry recovers removal evidence too)",
            `sporadic (closed): expected closed, got ${r}`);
    });
}

async function testSporadicRefusalDoesNotTripTheBreaker() {
    // THE Blue Origin regression. Ten probes, each refusing once and then
    // answering. Under the old rule the first three refusals parked the tenant
    // for six hours; now none of them is a refusal at all, because the retry
    // reached a verdict and noteCxsSuccess wiped the count.
    await withFixture((url, nth) => {
        if (!isCxs(url)) return { status: 200, body: WORKDAY_SPA_SHELL };
        return nth === 1 ? { status: 403, body: CXS_PERMISSION_DENIED } : { status: 200, body: CXS_LIVE };
    }, async (rec) => {
        const verdicts: LivenessResult[] = [];
        for (let i = 10; i < 20; i++) {
            verdicts.push(await probePostingLiveness({ externalId: `e${i}`, sourceUrl: blueOrigin(i) }, "workday"));
        }
        check(verdicts.every(v => v === "alive"), "sporadic: 10 consecutive 403-then-200 probes all resolve alive",
            `sporadic: expected 10 alive, got ${verdicts.join(",")}`);
        // 10 probes × 2 requests. If the breaker had tripped, the later probes
        // would have spent ZERO requests, so this count is the breaker check.
        check(rec.total() === 20, "sporadic: breaker never opened (all 10 probes still reached the network)",
            `sporadic: expected 20 requests, got ${rec.total()} — a short count means the CXS breaker parked a healthy tenant`);
        check(rec.count(u => !isCxs(u)) === 0, "sporadic: never fell back to the same-host HTML page",
            `sporadic: ${rec.count(u => !isCxs(u))} HTML fallback request(s) issued after a recovered refusal`);
    });
}

async function testSporadicRefusalDoesNotAbortTheBatch() {
    // The headline number: `candidates=922 alive=1 unknown=921`. Every posting
    // here refuses once and then answers; the whole batch must come back with
    // real verdicts and nothing may be discarded.
    const inputs: ProbeInput[] = Array.from({ length: 20 }, (_, i) => ({
        externalId: `e${i}`,
        sourceUrl: blueOrigin(100 + i),
    }));
    await withFixture((url, nth) => {
        if (!isCxs(url)) return { status: 200, body: WORKDAY_SPA_SHELL };
        return nth === 1 ? { status: 403, body: CXS_PERMISSION_DENIED } : { status: 200, body: CXS_LIVE };
    }, async (rec) => {
        const results = await probeBatch(inputs, "workday");
        const c = verdictCounts(results);
        check(c.alive === 20 && c.unknown === 0,
            "sporadic batch: all 20 postings got a real verdict (pre-fix: 1 alive, 19 discarded)",
            `sporadic batch: expected 20 alive / 0 unknown, got ${JSON.stringify(c)}`);
        check(rec.total() === 40, "sporadic batch: 40 requests (20 probes × 2) — no probe was short-circuited",
            `sporadic batch: expected 40 requests, got ${rec.total()}`);
    });
}

async function testRefusalsSeparatedByVerdictsDoNotAccumulate() {
    // The consecutive rule, at its edge, with the separators being DEFINITIVE
    // verdicts — the only thing that actually clears the run (see
    // SOFT_REFUSAL_ABORT_AFTER). Postings 0,1 refuse through all three attempts;
    // posting 2 answers `alive`, breaking the run; 3,4 refuse; 5 answers; 6-9
    // answer. Four fully-refused probes in a 10-posting batch, never three
    // without a verdict between them, so the tick must run to completion.
    //
    // Serial kind so the ordering is deterministic — a parallel kind would let
    // completion order drift and make "in a row" untestable at this precision.
    const kind: WatchlistKind = "careers-page";
    const refusing = new Set([0, 1, 3, 4]);
    const inputs: ProbeInput[] = Array.from({ length: 10 }, (_, i) => ({
        externalId: `e${i}`,
        sourceUrl: `https://boards.example.com/careers/p${i}`,
    }));
    await withFixture((url) => {
        const i = Number(url.split("/p")[1]);
        return refusing.has(i) ? { status: 403 } : { status: 200, body: "ok" };
    }, async (rec) => {
        const results = await probeBatch(inputs, kind, { profile: { perHitDelayMs: 1 } });
        const c = verdictCounts(results);
        check(c.alive === 6 && c.unknown === 4,
            "separated by verdicts: 4 refusals never abort the batch (6 alive / 4 unknown)",
            `separated by verdicts: expected 6 alive / 4 unknown, got ${JSON.stringify(c)}`);
        // 4 refused × 3 attempts + 6 answered × 1 = 18. An abort would have
        // stopped the fetches early and left this well short.
        check(rec.total() === 18, "separated by verdicts: every posting was actually probed (18 requests)",
            `separated by verdicts: expected 18 requests, got ${rec.total()}`);
    });
}

async function testNonVerdictSeparatorsDoNotClearTheRun() {
    // The other half of the same rule, and the reason the test above is named
    // for VERDICTS rather than for spacing. A non-refusal "unknown" is NEUTRAL:
    // it neither counts toward the abort nor clears the run. So 403s at 0, 4 and
    // 8, separated only by inconclusive probes, DO abort — at probe 8.
    //
    // Pinned rather than merely documented because it is the behaviour that
    // matters for the kinds whose probes mostly resolve "unknown" (LinkedIn /
    // Indeed behind interstitials, SPA-rendered Workday tenants on the HTML
    // fallback), and because the naive reading of "3 in a row" predicts the
    // opposite.
    const refusing = new Set([0, 4, 8]);
    const inputs: ProbeInput[] = Array.from({ length: 12 }, (_, i) => ({
        externalId: `e${i}`,
        sourceUrl: `https://boards.example.com/careers/p${i}`,
    }));
    await withFixture((url) => {
        const i = Number(url.split("/p")[1]);
        // 400 is not a BACKOFF_STATUS, so it resolves "unknown" without being a
        // refusal — the neutral outcome.
        return refusing.has(i) ? { status: 403 } : { status: 400 };
    }, async (rec) => {
        const results = await probeBatch(inputs, "careers-page", { profile: { perHitDelayMs: 1 } });
        check(verdictCounts(results).unknown === 12,
            "neutral separators: every posting resolves 'unknown' (never 'closed')",
            `neutral separators: expected 12 unknown, got ${JSON.stringify(verdictCounts(results))}`);
        // Probes 0-8 run: 3 refused × 3 attempts + 6 neutral × 1 = 15 requests,
        // then the third refusal (probe 8) aborts and 9-11 never fetch.
        check(rec.total() === 15,
            "neutral separators: a non-refusal 'unknown' does NOT clear the run — aborted at the 3rd refusal (15 requests)",
            `neutral separators: expected 15 requests, got ${rec.total()}`);
    });
}

// ─── 2. The deterministic case — still refused, still parked ──────────────

async function testPersistentRefusalStillTripsTheBreaker() {
    // Boeing's shape: 403 forever. The breaker must still park the tenant, and
    // the park must still cost ZERO network — that is the whole point of it.
    await withFixture((url) => isCxs(url)
        ? { status: 403, body: CXS_PERMISSION_DENIED }
        : { status: 200, body: WORKDAY_SPA_SHELL },
    async (rec) => {
        const verdicts: LivenessResult[] = [];
        for (let i = 0; i < 3; i++) {
            verdicts.push(await probePostingLiveness({ externalId: `b${i}`, sourceUrl: boeing(i) }, "workday"));
        }
        check(verdicts.every(v => v === "unknown"), "persistent: every refused probe resolves 'unknown'",
            `persistent: expected all unknown, got ${verdicts.join(",")}`);
        // WORKDAY_CXS_TRIP_AFTER (3) refused probes × 3 attempts each.
        const afterTrip = rec.total();
        check(afterTrip === 9, "persistent: breaker trips after 3 refused probes, costing 9 requests",
            `persistent: expected 9 requests to trip the breaker, got ${afterTrip}`);
        check(rec.count(u => !isCxs(u)) === 0, "persistent: a refusal never triggers the same-host HTML fallback",
            `persistent: ${rec.count(u => !isCxs(u))} HTML fallback request(s) — that is the hammering the breaker exists to stop`);

        // Breaker open. The next probe must spend NOTHING — in particular the
        // retry loop must not run: the open-breaker path returns before any
        // probeViaHttpStatus call, and that ordering is load-bearing.
        const r = await probePostingLiveness({ externalId: "b9", sourceUrl: boeing(9) }, "workday");
        check(rec.total() === afterTrip, "persistent: an open breaker spends zero requests (retries do NOT run behind it)",
            `persistent: open breaker issued ${rec.total() - afterTrip} request(s) — retries leaked past the breaker`);
        check(r === "unknown", "persistent: breaker-skipped probe → unknown (never closed)",
            `persistent: breaker-skipped probe returned ${r}`);
    });
}

async function testPersistentRefusalStillAbortsTheBatch_AndVolumeIsBounded() {
    // The other half of the protection, and the number that must never drift.
    // Formula from SOFT_REFUSAL_ABORT_AFTER's note:
    //   (ABORT_AFTER + concurrency − 1) × attempts × calls-per-probe
    //   = (3 + 2 − 1) × 3 × 1 = 12 for workday.
    // The floor is 9 (a perfectly serialized run); anything above 12 means a
    // sibling probe escaped the abort, which is how the 2026-07-31 incident
    // started.
    const profile = PROBE_PROFILES.workday;
    const maxExpected = (3 + profile.concurrency - 1) * 3;
    const inputs: ProbeInput[] = Array.from({ length: profile.maxPerTick }, (_, i) => ({
        externalId: `b${i}`,
        sourceUrl: boeing(200 + i),
    }));
    await withFixture((url) => isCxs(url)
        ? { status: 403, body: CXS_PERMISSION_DENIED }
        : { status: 200, body: WORKDAY_SPA_SHELL },
    async (rec) => {
        const results = await probeBatch(inputs, "workday");
        const c = verdictCounts(results);
        check(results.size === inputs.length && c.unknown === inputs.length,
            `persistent batch: all ${inputs.length} postings resolve 'unknown' (never 'closed')`,
            `persistent batch: expected ${inputs.length} unknown, got ${JSON.stringify(c)}`);
        check(rec.total() >= 9 && rec.total() <= maxExpected,
            `persistent batch: bounded at ${rec.total()} requests for ${inputs.length} postings (documented ceiling ${maxExpected})`,
            `persistent batch: expected 9..${maxExpected} requests, got ${rec.total()} — the batch abort is leaking`);
    });
}

/**
 * A REFUSAL FOLLOWED BY A NON-VERDICT STILL COUNTS AS A REFUSAL.
 *
 * The regression this pins: the first version of the retry loop cleared the
 * refusal status at the top of every attempt and only reported one if the LAST
 * attempt was itself a refusal. So 403-then-timeout (and 403-then-network-error,
 * and 403-then-SSRF-trip) produced "unknown" carrying no refusal signal at all,
 * and three separate protections failed open together: the CXS breaker never
 * tripped, probeWorkday ran its same-host HTML fallback anyway, and probeBatch's
 * run neither advanced nor cleared so the tick never aborted. Measured at the
 * time: 10 postings → 30 requests and 5.5s, where the pre-retry code spent 1
 * request and aborted.
 */
async function testRefusalThenNonVerdictStillCountsAsRefusal() {
    // 403 on attempt 1, then the host stops answering entirely. `timeoutMs` is
    // small so the hang resolves quickly; the backoff is left fast.
    const inputs: ProbeInput[] = Array.from({ length: 10 }, (_, i) => ({
        externalId: `b${i}`,
        sourceUrl: boeing(300 + i),
    }));
    await withFixture((url, nth) => {
        if (!isCxs(url)) return { status: 200, body: WORKDAY_SPA_SHELL };
        return nth === 1 ? { status: 403, body: CXS_PERMISSION_DENIED } : "hang";
    }, async (rec) => {
        const results = await probeBatch(inputs, "workday", { profile: { timeoutMs: 1100 } });
        check(verdictCounts(results).unknown === inputs.length,
            "403-then-hang: every posting resolves 'unknown' (never 'closed')",
            `403-then-hang: expected 10 unknown, got ${JSON.stringify(verdictCounts(results))}`);
        // The refusal is latched, so probe 1 reports it despite the hang. Three
        // such probes abort the batch; with concurrency 2 a fourth may already
        // be in flight. Each refused probe costs at most 2 requests here (403 +
        // the hang that eats the rest of the budget).
        check(rec.total() <= 8,
            `403-then-hang: bounded at ${rec.total()} requests — the latched refusal still aborts the batch`,
            `403-then-hang: expected ≤8 requests, got ${rec.total()} — the refusal was forgotten and every protection failed open`);
        check(rec.count(u => !isCxs(u)) === 0,
            "403-then-hang: still skips the same-host HTML fallback (the request a refusal must never be followed by)",
            `403-then-hang: ${rec.count(u => !isCxs(u))} HTML fallback request(s) — probeWorkday's refusal latch was lost`);
    });

    // Same shape one layer down: the breaker must still trip. Sequential
    // probes, so no batch abort is involved — this isolates noteCxsRefusal.
    await withFixture((url, nth) => {
        if (!isCxs(url)) return { status: 200, body: WORKDAY_SPA_SHELL };
        return nth === 1 ? { status: 403, body: CXS_PERMISSION_DENIED } : "hang";
    }, async (rec) => {
        for (let i = 0; i < 3; i++) {
            await probePostingLiveness({ externalId: `b${i}`, sourceUrl: boeing(400 + i) }, "workday", { timeoutMs: 1100 });
        }
        const afterTrip = rec.total();
        await probePostingLiveness({ externalId: "b9", sourceUrl: boeing(409) }, "workday", { timeoutMs: 1100 });
        check(rec.total() === afterTrip,
            "403-then-hang: the CXS breaker still trips (4th probe spends zero requests)",
            `403-then-hang: breaker did not trip — 4th probe issued ${rec.total() - afterTrip} request(s)`);
    });

    // A refusal followed by an ambiguous 200 is the same class: no evidence was
    // reached, so it must still report as a refusal rather than being swallowed.
    await withFixture((url, nth) => {
        if (!isCxs(url)) return { status: 200, body: WORKDAY_SPA_SHELL };
        // 200 with no recognizable tier-4 flag → probeWorkday's "shape drift".
        return nth === 1 ? { status: 403, body: CXS_PERMISSION_DENIED } : { status: 200, body: `{}` };
    }, async (rec) => {
        for (let i = 0; i < 3; i++) {
            await probePostingLiveness({ externalId: `b${i}`, sourceUrl: boeing(500 + i) }, "workday");
        }
        const afterTrip = rec.total();
        await probePostingLiveness({ externalId: "b9", sourceUrl: boeing(509) }, "workday");
        check(rec.total() === afterTrip,
            "403-then-ambiguous-200: still a refusal — the breaker trips and the HTML fallback is skipped",
            `403-then-ambiguous-200: breaker did not trip — 4th probe issued ${rec.total() - afterTrip} request(s)`);
    });
}

/**
 * A VERDICT REACHED VIA A FALLBACK ENDPOINT CLEARS THE RUN.
 *
 * probeGreenhouse and probeLever interrogate TWO endpoints — the structured API
 * first, then the canonical HTML page — and both receive the same refusal sink.
 * So one posting can register a soft refusal AND return a perfectly good
 * `alive`. The first version of runProbe put the refusal branch above the
 * verdict branch, making "counted as a refusal" and "cleared the run" mutually
 * exclusive: measured at 20 greenhouse postings with the API 403ing and the HTML
 * answering, the batch produced 10 genuine `alive` verdicts and then aborted —
 * silently capping close-detection on the fleet's largest kind at ~10 postings
 * per tick, which is the same self-inflicted blackout this change exists to
 * remove.
 */
async function testFallbackVerdictClearsTheRun() {
    const inputs: ProbeInput[] = Array.from({ length: 20 }, (_, i) => ({
        externalId: `g${i}`,
        sourceUrl: `https://job-boards.greenhouse.io/acme/jobs/${1000 + i}`,
    }));
    const isApi = (u: string) => u.includes("boards-api.greenhouse.io");

    await withFixture((url) => isApi(url) ? { status: 403 } : { status: 200, body: "ok" }, async (rec) => {
        const results = await probeBatch(inputs, "greenhouse");
        const c = verdictCounts(results);
        check(c.alive === 20 && c.unknown === 0,
            "fallback verdict: API 403 + HTML fine → all 20 postings alive, batch never aborts",
            `fallback verdict: expected 20 alive / 0 unknown, got ${JSON.stringify(c)} — a soft refusal on the API is still consuming the abort budget`);
        // 20 probes × (3 API attempts + 1 HTML) = 80. A short count means the
        // batch aborted early; a long one means the retry budget leaked.
        check(rec.total() === 80,
            "fallback verdict: 80 requests (20 × [3 API attempts + 1 HTML fallback])",
            `fallback verdict: expected 80 requests, got ${rec.total()}`);
    });

    // The deliberate asymmetry, pinned so it is not "fixed" by accident. A HARD
    // refusal is a politeness OBLIGATION, not evidence, and reaching a verdict
    // through a DIFFERENT endpoint does not discharge it — otherwise a 429ing
    // boards-api.greenhouse.io would keep taking 200 more hits in the same tick
    // just because the HTML page happens to answer. This is the one place the
    // implementation departs from the review's suggested branch order.
    await withFixture((url) => isApi(url) ? { status: 429 } : { status: 200, body: "ok" }, async (rec) => {
        await probeBatch(inputs, "greenhouse");
        check(rec.total() <= 20,
            `hard refusal on a fallback kind: still aborts on sight (${rec.total()} requests, not 80)`,
            `hard refusal on a fallback kind: expected ≤20 requests, got ${rec.total()} — a 429 is being discharged by the fallback's verdict`);
    });
}

async function testSporadicTenantVolumeIsBounded() {
    // THE BOUND THAT WAS MISSING. `softRefusalsInARow` only reaches 3 when
    // probes refuse consecutively, so a PARTIALLY-refusing tenant never aborts
    // and, before SOFT_REFUSAL_RETRY_BUDGET, its only ceiling was
    // `maxPerTick × attempts × calls-per-probe`. Measured then: 140 requests for
    // a 60-posting workday batch, against a `maxPerTick` of 60 that had been cut
    // from 500 precisely because of a 15-day IP block. Ceilings were 180
    // (workday) and 1,200 (greenhouse).
    //
    // Fixture: 2 of every 3 attempts refuse — hot enough that the retry budget
    // is the only thing standing between us and that number, and irregular
    // enough that no consecutive-refusal abort fires.
    const profile = PROBE_PROFILES.workday;
    const budget = Math.max(2, Math.ceil(profile.maxPerTick / 2));
    const ceiling = profile.maxPerTick * 1 + budget;   // 1 CXS call per probe
    const inputs: ProbeInput[] = Array.from({ length: profile.maxPerTick }, (_, i) => ({
        externalId: `e${i}`,
        sourceUrl: blueOrigin(600 + i),
    }));
    let served = 0;
    await withFixture((url) => {
        if (!isCxs(url)) return { status: 200, body: WORKDAY_SPA_SHELL };
        return (served++ % 3 === 2) ? { status: 200, body: CXS_LIVE } : { status: 403, body: CXS_PERMISSION_DENIED };
    }, async (rec) => {
        const results = await probeBatch(inputs, "workday");
        check(results.size === inputs.length,
            `sporadic ceiling: all ${inputs.length} postings accounted for`,
            `sporadic ceiling: expected ${inputs.length} results, got ${results.size}`);
        check(verdictCounts(results).closed === 0,
            "sporadic ceiling: no posting was closed by a refusal",
            "sporadic ceiling: a refusal produced 'closed' — FALSE-CLOSE RISK");
        check(rec.total() <= ceiling,
            `sporadic ceiling: ${rec.total()} requests ≤ ${ceiling} (maxPerTick ${profile.maxPerTick} + retry budget ${budget}); pre-budget this measured 140`,
            `sporadic ceiling: ${rec.total()} requests EXCEEDS the ${ceiling} bound — the shared retry budget is not holding`);
        // And the win is preserved: a partially-refusing tenant still gets real
        // verdicts, which is the entire point of retrying at all.
        check(verdictCounts(results).alive > 0,
            `sporadic ceiling: still reached ${verdictCounts(results).alive} real verdicts under the budget`,
            "sporadic ceiling: the budget starved the batch of verdicts entirely");
    });
}

async function testExhaustedRetriesNeverClose() {
    // The standing risk in this module is mass-FALSE-CLOSE. A refusal that
    // outlives its retries is still not evidence about the posting, on any kind.
    const kinds: WatchlistKind[] = ["workday", "greenhouse", "lever", "smartrecruiters", "careers-page"];
    for (const kind of kinds) {
        await withFixture(() => ({ status: 403, body: CXS_PERMISSION_DENIED }), async () => {
            const r = await probePostingLiveness(
                { externalId: "x", sourceUrl: `https://boards.example.com/${kind}/job/abc123` },
                kind,
            );
            check(r === "unknown", `${kind}: 403 through all retries → unknown (never closed)`,
                `${kind}: exhausted retries returned '${r}' — FALSE-CLOSE RISK`);
        });
    }
}

// ─── 3. Hard refusals keep their pre-existing, stricter treatment ─────────

async function testHardRefusalsAreNotRetried() {
    // 429 is the source telling us to slow down in the standard way, and a 5xx
    // means a Workday tenant is already degrading under our pressure (200 → 403
    // → 500). Re-asking either one 300ms later is the opposite of backing off.
    for (const status of [429, 500, 502, 503]) {
        await withFixture(() => ({ status }), async (rec) => {
            const r = await probePostingLiveness(
                { externalId: "x", sourceUrl: "https://boards.example.com/careers-page/job/abc" },
                "careers-page",
            );
            check(rec.total() === 1, `hard refusal ${status}: exactly 1 request (not retried)`,
                `hard refusal ${status}: expected 1 request, got ${rec.total()}`);
            check(r === "unknown", `hard refusal ${status}: → unknown`,
                `hard refusal ${status}: expected unknown, got ${r}`);
        });
    }
}

async function testHardRefusalStillAbortsOnSight() {
    // Unchanged from before this fix: ONE 429/5xx ends the tick. If this ever
    // relaxes to the soft-refusal rule, we have traded a real protection away.
    const inputs: ProbeInput[] = Array.from({ length: 10 }, (_, i) => ({
        externalId: `e${i}`,
        sourceUrl: `https://boards.example.com/careers/p${i}`,
    }));
    for (const status of [429, 503]) {
        await withFixture(() => ({ status }), async (rec) => {
            const results = await probeBatch(inputs, "careers-page", { profile: { perHitDelayMs: 1 } });
            check(rec.total() === 1, `hard refusal ${status} aborts the batch on sight (1 request for 10 postings)`,
                `hard refusal ${status}: expected 1 request, got ${rec.total()}`);
            check(verdictCounts(results).unknown === 10, `hard refusal ${status}: all 10 postings → unknown`,
                `hard refusal ${status}: expected 10 unknown, got ${JSON.stringify(verdictCounts(results))}`);
        });
    }

    // Mixed: a soft refusal in flight followed by a hard one must abort at the
    // hard one, without waiting for the soft run to reach three.
    await withFixture((url) => url.includes("/p0") ? { status: 403 } : { status: 429 }, async (rec) => {
        await probeBatch(inputs, "careers-page", { profile: { perHitDelayMs: 1 } });
        // p0: 3 attempts (soft, retried, run=1). p1: 1 attempt, 429 → abort.
        check(rec.total() === 4, "mixed: soft 403 (3 attempts) then a 429 → aborts immediately at 4 requests",
            `mixed: expected 4 requests, got ${rec.total()}`);
    });
}

// ─── 4. The retry lives inside the caller's timeout budget ────────────────

async function testRetriesRespectTheTimeoutBudget() {
    // Retries share `timeoutMs` — they do not extend it. Real backoff values
    // here on purpose: this is the one section whose assertion is wall-clock.
    _setSoftRefusalBackoffForTests(300);
    try {
        // (a) instant 403s — three attempts plus two backoffs, comfortably
        //     inside a 5s budget.
        await withFixture(() => ({ status: 403 }), async (rec) => {
            const t0 = Date.now();
            const r = await probePostingLiveness(
                { externalId: "x", sourceUrl: "https://boards.example.com/careers-page/job/a" },
                "careers-page", { timeoutMs: 5000 },
            );
            const elapsed = Date.now() - t0;
            check(rec.total() === 3 && elapsed < 5000,
                `budget: instant 403s → 3 attempts in ${elapsed}ms, inside the 5000ms budget`,
                `budget: expected 3 attempts under 5000ms, got ${rec.total()} attempts in ${elapsed}ms`);
            check(r === "unknown", "budget: instant 403s → unknown", `budget: expected unknown, got ${r}`);
        });

        // (b) SLOW 403s against a tight budget — SOFT_REFUSAL_MIN_ATTEMPT_MS
        //     must REFUSE TO SCHEDULE a second attempt rather than let the probe
        //     overrun. A 900ms refusal against a 2000ms budget leaves ~1100ms;
        //     minus a 300–600ms backoff that is under the 1000ms floor, so the
        //     loop stops at ONE attempt. Asserting `=== 1` (not `<= 3`) is what
        //     makes this pin the guard it is named for — `<= 3` passes against
        //     code with no guard at all.
        await withFixture(() => ({ status: 403, delayMs: 900 }), async (rec) => {
            const t0 = Date.now();
            await probePostingLiveness(
                { externalId: "x", sourceUrl: "https://boards.example.com/careers-page/job/b" },
                "careers-page", { timeoutMs: 2000 },
            );
            const elapsed = Date.now() - t0;
            check(elapsed <= 2400, `budget: slow 403s finished in ${elapsed}ms, within the 2000ms budget (+slack)`,
                `budget: slow 403s took ${elapsed}ms against a 2000ms budget — retries are overrunning it`);
            check(rec.total() === 1, "budget: min-attempt guard stopped the retry (exactly 1 attempt, no doomed second)",
                `budget: expected exactly 1 attempt, got ${rec.total()} — SOFT_REFUSAL_MIN_ATTEMPT_MS is not holding`);
        });

        // (c) a host that never answers. A timeout is NOT a refusal and must not
        //     be retried — it already spent the budget the retries come from.
        await withFixture(() => "hang", async (rec) => {
            const t0 = Date.now();
            const r = await probePostingLiveness(
                { externalId: "x", sourceUrl: "https://boards.example.com/careers-page/job/c" },
                "careers-page", { timeoutMs: 1200 },
            );
            const elapsed = Date.now() - t0;
            check(rec.total() === 1, "budget: a timed-out probe is not retried (exactly 1 request)",
                `budget: expected 1 request on timeout, got ${rec.total()}`);
            check(elapsed < 2400, `budget: timed-out probe returned in ${elapsed}ms (budget 1200ms)`,
                `budget: timed-out probe took ${elapsed}ms against a 1200ms budget`);
            check(r === "unknown", "budget: timed-out probe → unknown", `budget: expected unknown, got ${r}`);
        });
    } finally {
        _setSoftRefusalBackoffForTests(FAST_BACKOFF_MS);
    }
}

// ─── 4b. Retries obey the profile's same-host pacing floor ────────────────

async function testRetriesRespectPerHitDelay() {
    // probeBatch's contract says "same host can't be hit faster than
    // perHitDelayMs". The first version of the retry ignored it: measured
    // inter-request gaps on a refusing LinkedIn batch were
    // `472, 752, 1501, 377, 957, 1501, …` — everything but the 1501s was a
    // retry outrunning the profile, on the most bot-sensitive source in the
    // fleet and on the one kind where a 403 is a block that never clears.
    //
    // The fast test backoff (2ms) is left in place ON PURPOSE: it makes the
    // floor the ONLY thing that could produce a gap, so the assertion cannot
    // pass by accident on the jitter.
    const floorMs = 400;
    await withFixture(() => ({ status: 403 }), async (rec) => {
        await probeBatch(
            [{ externalId: "x", sourceUrl: "https://boards.example.com/careers/p0" }],
            "careers-page",
            { profile: { perHitDelayMs: floorMs } },
        );
        const t = rec.times();
        check(t.length === 3, `pacing floor: 3 attempts issued (got ${t.length})`,
            `pacing floor: expected 3 attempts, got ${t.length}`);
        const gaps = t.slice(1).map((v, i) => v - t[i]);
        // 10% slack for timer imprecision; the un-floored failure mode is ~2ms,
        // so there is no ambiguity about which side of this a regression lands.
        const ok = gaps.every(g => g >= floorMs * 0.9);
        check(ok, `pacing floor: retry gaps [${gaps.join(", ")}]ms all ≥ perHitDelayMs (${floorMs}ms)`,
            `pacing floor: retry gaps [${gaps.join(", ")}]ms undercut perHitDelayMs (${floorMs}ms) — retries are outrunning the profile`);
    });
}

// ─── 5. Health attribution is per PROBE, not per attempt ──────────────────

async function testRetriesRecordOneHealthRow() {
    // A retried probe is ONE upstream touch as far as the Fetcher Health card
    // is concerned. Counting each attempt would make a recovering tenant look
    // three times busier than it is, and a refusing one three times sicker.
    const health = await import("@/lib/fetcher-health/store");
    await health._statsForTests(); // settle store init

    const readFor = async (host: string) => {
        const { health: byHost } = await health.readFetcherHealth(
            Date.now(), health.currentTier(), health.currentSource(), "1d",
        );
        return byHost[host] ?? { ok: 0, error: 0, fallback: 0, broken: 0 };
    };

    await withFixture((_url, nth) => nth === 1 ? { status: 403 } : { status: 200, body: "ok" }, async () => {
        await probePostingLiveness(
            { externalId: "x", sourceUrl: "https://retry-recovered.example/careers/job/a" },
            "careers-page",
        );
    });
    const recovered = await readFor("retry-recovered.example");
    check(recovered.ok === 1 && recovered.error === 0,
        "health: a probe that recovered on retry records ONE ok row",
        `health: expected ok=1 error=0 for a recovered probe, got ok=${recovered.ok} error=${recovered.error}`);

    await withFixture(() => ({ status: 403 }), async () => {
        await probePostingLiveness(
            { externalId: "x", sourceUrl: "https://retry-refused.example/careers/job/a" },
            "careers-page",
        );
    });
    const refused = await readFor("retry-refused.example");
    check(refused.error === 1 && refused.ok === 0,
        "health: a probe refused through all 3 attempts records ONE error row, not three",
        `health: expected ok=0 error=1 for an exhausted probe, got ok=${refused.ok} error=${refused.error}`);
}

async function main() {
    await testSporadicRefusalRecoversToAVerdict();
    await testSporadicRefusalDoesNotTripTheBreaker();
    await testSporadicRefusalDoesNotAbortTheBatch();
    await testRefusalsSeparatedByVerdictsDoNotAccumulate();
    await testNonVerdictSeparatorsDoNotClearTheRun();
    await testPersistentRefusalStillTripsTheBreaker();
    await testPersistentRefusalStillAbortsTheBatch_AndVolumeIsBounded();
    await testRefusalThenNonVerdictStillCountsAsRefusal();
    await testFallbackVerdictClearsTheRun();
    await testSporadicTenantVolumeIsBounded();
    await testExhaustedRetriesNeverClose();
    await testHardRefusalsAreNotRetried();
    await testHardRefusalStillAbortsOnSight();
    await testRetriesRespectTheTimeoutBudget();
    await testRetriesRespectPerHitDelay();
    await testRetriesRecordOneHealthRow();

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
