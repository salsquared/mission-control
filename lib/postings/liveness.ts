/**
 * Closed-posting probe gate.
 *
 * Design + rationale: docs/archive/close-detection-probe.md.
 *
 * Job-watcher previously decided a posting was closed purely on "the fetcher
 * hasn't returned this externalId in 6h." That's a false-positive whenever the
 * fetcher's view of the source is incomplete (LinkedIn's 24h filter, Workday's
 * 200-per-crawl page cap on tenants with 1k+ jobs). This module gates the
 * close path on a direct probe of the posting's sourceUrl. Only positive
 * evidence of removal flips the row. Network errors / ambiguity → "unknown"
 * and we leave the row alone for the next tick.
 *
 * Per-kind heuristics live in PROBE_HANDLERS. The marker lists for the
 * HTML-scraping kinds (linkedin, indeed, ashby, workday) are initial guesses derived
 * from a small sample of probed pages; they can grow over time without
 * re-architecting anything. Grep for `[liveness] kind=<x> unknown` in
 * production logs to spot recurring miss patterns.
 */
import { loggedFetch, hostOf } from "@/lib/external-fetch";
import { recordFetchOutcome } from "@/lib/fetcher-health/store";
import { assertExternalHttpUrl, assertSafeResponseUrl, UnsafeURLError } from "@/lib/security/url-guard";
import type { WATCHLIST_KINDS } from "@/lib/schemas/watchlists";

/**
 * Optional callback fired when a probe sees a REFUSAL from the source — 429,
 * 403, or 5xx (see BACKOFF_STATUSES) — that SURVIVED the bounded retry in
 * probeViaHttpStatus. `probeBatch` wires this to a shared abort flag so
 * subsequent probes in the batch short-circuit instead of hammering a host
 * that's already telegraphing back-off.
 *
 * Named for the 429 case it originally handled and kept that way because it is
 * part of `probePostingLiveness`'s options bag. (An earlier version of this note
 * claimed external callers pass it by name — they do not: as of 2026-08-02
 * `probeBatch` is its ONLY caller. scripts/tests/debug/recover-false-closed.ts
 * passes only `profile`, and the close-detection audit probe passes no options
 * at all. Renaming it is therefore cheap, if a future reader wants to.)
 *
 * FIRING CONTRACT — read before relying on it. At most once per
 * probeViaHttpStatus CALL, not per probe. A handler that interrogates two
 * endpoints (probeGreenhouse and probeLever: API, then the HTML fallback) can
 * fire it TWICE for one posting, and probeWorkday routes its CXS call through a
 * wrapper. `probeBatch` therefore folds it into per-probe LATCHES rather than
 * counters — don't write a caller that counts invocations.
 *
 * The refusal STATUS is threaded through (2026-08-02) because probeBatch no
 * longer treats every refusal identically: a 429/5xx is an unambiguous "stop"
 * and aborts the batch on sight, while a 403 is the ambiguous one and needs
 * SOFT_REFUSAL_ABORT_AFTER consecutive occurrences. See SOFT_REFUSAL_STATUSES.
 * The parameter is OPTIONAL, and a zero-arg `() => {...}` is assignable to this
 * type, so every existing callback keeps compiling untouched.
 */
type RateLimitCallback = (status?: number) => void;

/**
 * Everything a per-kind probe needs beyond the posting itself.
 *
 * Replaced the old `(p, timeoutMs, onRateLimit?)` positional triple on
 * 2026-08-02, when the retry work needed to thread two MORE per-batch knobs
 * (`takeRetry`, `minRetryDelayMs`) down to probeViaHttpStatus through eight
 * handlers. Growing the arity a fourth and fifth time — on a helper that
 * already had callers passing `undefined` just to reach a later parameter —
 * was the worse of the two churns, and this way the next knob costs one field
 * instead of eight signatures.
 */
interface ProbeContext {
    /** Total wall-clock budget for ONE probeViaHttpStatus call, retries included. */
    timeoutMs: number;
    /** See RateLimitCallback. */
    onRateLimit?: RateLimitCallback;
    /**
     * Batch-wide retry allowance. Returns true if this probe may spend one
     * EXTRA attempt. Absent ⇒ retries are allowed freely (bounded per-probe by
     * SOFT_REFUSAL_MAX_RETRIES), which is what a direct probePostingLiveness
     * caller with no batch around it gets — the audit probe in
     * scripts/tests/probes/close-detection-audit.ts paces itself.
     *
     * probeBatch always supplies one. See SOFT_REFUSAL_RETRY_BUDGET for why a
     * per-probe cap alone is not a bound.
     */
    takeRetry?: () => boolean;
    /**
     * Floor on the retry backoff, so a retry cannot outrun the profile's
     * documented same-host pacing (`perHitDelayMs`). Set by probeBatch; absent
     * ⇒ no floor.
     */
    minRetryDelayMs?: number;
}

/**
 * Statuses treated as "the source is refusing us", not as evidence about the
 * posting. All three resolve "unknown" and all three can abort the rest of the
 * batch — but since 2026-08-02 they do NOT do so on the same terms: 403 is
 * retried first and needs SOFT_REFUSAL_ABORT_AFTER consecutive probes, 429/5xx
 * still abort on sight. See SOFT_REFUSAL_STATUSES.
 *
 *   429 — the textbook signal, but Workday essentially never sends it.
 *   403 — what Workday ACTUALLY returns when backing us off. Until 2026-07-31
 *         this fell through to the silent `!res.ok → unknown` below, so the
 *         abort flag never tripped and we kept hammering the full 500-probe
 *         tick. Only 31 back-off aborts fired in 24h against 5,558 failed
 *         Workday probes.
 *   5xx — the same refusal one layer down. Observed live: a Workday tenant
 *         degrades 200 → 403 → 500 as probe pressure accumulates.
 *
 * IMPORTANT — 403 is deliberately NOT mapped to "closed". Live testing found
 * Workday's 403 to be deterministic per-posting at concurrency 1 (which looks
 * like "this posting is gone") *and* to spread to known-live postings as load
 * accumulates (which looks like throttling). The evidence does not separate
 * those, and guessing "closed" would re-introduce exactly the mass false-close
 * this probe gate exists to prevent. Ambiguity resolves to "unknown" — the row
 * is left alone and re-probed on a later tick.
 */
const BACKOFF_STATUSES = (status: number): boolean =>
    status === 429 || status === 403 || status >= 500;

/**
 * SOFT vs HARD refusals (2026-08-02).
 *
 * BACKOFF_STATUSES lumps three statuses together, and until now the whole
 * module did too: ONE refusal anywhere killed the rest of the tick (~59 of 60
 * Workday probes discarded) and counted a full strike toward the 6h per-tenant
 * CXS breaker. Live measurement on 2026-08-02 showed that conflates two
 * behaviours that must NOT be handled the same way:
 *
 *   SPORADIC — Blue Origin (wd5). Its CXS detail endpoint WORKS. A run of 10
 *     sequential probes returned 200 ten times out of ten; an earlier
 *     back-to-back burst of 12 returned 8× 200 and 4× 403. The 403 is
 *     intermittent, load-shaped, and self-recovers within milliseconds. Yet
 *     close-detection was fully dark for its 1,621 postings, with the live log
 *     reading `candidates=922 alive=1 unknown=921` — one probe succeeded, then
 *     OUR OWN back-off ended the tick. Nothing upstream was broken; the outage
 *     was entirely self-inflicted.
 *
 *   DETERMINISTIC — Boeing / Maxar / Axiom (wd1). `403 {"errorCode":"S22",
 *     "httpStatus":403,"message":"permission denied"}` on EVERY request; Boeing
 *     returned it 6 out of 6 at one request per second, far below any plausible
 *     rate limit. This is tenant configuration. No amount of pacing or retrying
 *     will ever produce a verdict, so the existing breaker is exactly right and
 *     must keep working — it stops us buying nothing with real requests.
 *
 * A 403 alone cannot tell those apart, so the fix is to spend a SMALL, BOUNDED
 * number of extra attempts and let the two separate themselves by outcome: the
 * sporadic case resolves to a real verdict on attempt 2 or 3 and never reaches
 * `onRateLimit` at all; the deterministic case burns its attempts, refuses
 * anyway, and trips both the batch abort and the breaker as before — just a few
 * requests later. Worst-case volume is worked out at SOFT_REFUSAL_ABORT_AFTER.
 *
 * WHY ONLY 403 IS SOFT. The other two BACKOFF_STATUSES are self-describing and
 * retrying them is actively wrong:
 *   429 — the source telling us, in the standard way, to slow down. Re-asking
 *         300ms later is the opposite of compliance.
 *   5xx — documented in PROBE_PROFILES: a Workday tenant degrades 200 → 403 →
 *         500 as probe pressure accumulates, so a 500 means we are ALREADY past
 *         the point of damage. Retrying adds load precisely when it hurts most.
 * Both keep their pre-existing behaviour: one occurrence aborts the batch.
 *
 * This changes nothing about the VERDICT mapping. A refusal that outlives its
 * retries is still "unknown", never "closed" — see the note on BACKOFF_STATUSES
 * for why mapping 403 to "closed" would mass-false-close and never self-heal.
 */
const SOFT_REFUSAL_STATUSES = (status: number): boolean => status === 403;

/**
 * Extra attempts a SOFT refusal buys, on top of the first one — so 3 requests
 * max per probe. Sized off the measurement above: at Blue Origin's worst
 * observed refusal rate (4/12 ≈ 33%, from a burst hotter than our profile
 * allows) three attempts leave a ~3.6% chance a probe still reads as refused,
 * versus ~11% at two attempts — which matters because probeBatch needs
 * SOFT_REFUSAL_ABORT_AFTER of those IN A ROW before it gives up, and 0.036³ is
 * negligible where 0.11³ is not. Going higher buys little and costs linearly.
 */
const SOFT_REFUSAL_MAX_RETRIES = 2;

/**
 * Backoff before a retry: `base << attempt`, plus up to 100% jitter of that
 * — 300–600ms then 600–1200ms. Jittered because probeBatch runs probes in
 * parallel and un-jittered retries would re-converge into exactly the burst
 * that provoked the 403.
 *
 * FLOORED at `profile.perHitDelayMs` (via ProbeContext.minRetryDelayMs). The
 * first version of this was not, and that quietly broke probeBatch's own
 * documented guarantee — "same host can't be hit faster than perHitDelayMs".
 * Measured inter-request gaps on a refusing LinkedIn batch read
 * `472, 752, 1501, 377, 957, 1501, …`: everything but the 1501s was a retry
 * outrunning the profile, on the most bot-sensitive source in the fleet and on
 * the one kind where a 403 is a Cloudflare block that will never clear. The
 * floor costs nothing where `perHitDelayMs` is 0 (workday, greenhouse, lever —
 * i.e. every kind the measurement was about) and makes the serial kinds honour
 * the pacing they advertise.
 *
 * Mutable only through the test seam below.
 */
const SOFT_REFUSAL_BACKOFF_MS = 300;
let softRefusalBackoffMs = SOFT_REFUSAL_BACKOFF_MS;

/**
 * Never start another attempt unless this much of the probe's timeout budget is
 * still unspent. Retries share the caller's `timeoutMs` — they do NOT extend it
 * — so a probe still finishes within its profile's budget (a refusal comes back
 * in milliseconds, so in practice the budget is barely touched); this guard is
 * what stops the last retry from being handed a stub of a deadline and timing
 * out for no reason.
 */
const SOFT_REFUSAL_MIN_ATTEMPT_MS = 1000;

/**
 * How many probes must refuse consecutively — each having already burned its
 * retries — before probeBatch stops the tick. Set to 3, matching
 * WORKDAY_CXS_TRIP_AFTER so the batch abort and the 6h per-tenant park land on
 * the same probe.
 *
 * WHAT "CONSECUTIVE" ACTUALLY MEANS, precisely, because the obvious reading is
 * wrong: three refusals with no DEFINITIVE verdict in between. Only an
 * alive/closed outcome clears the run. A probe that returns "unknown" without
 * having been refused (a plain timeout, an ambiguous 200 body, an SSRF-guard
 * trip) is NEUTRAL — it neither counts nor clears — so three 403s scattered
 * across a long tick, separated only by inconclusive probes, do abort it. That
 * is deliberate and it is the conservative direction: the alternative lets a
 * tenant that alternates refusal and non-verdict evade the abort forever, and
 * "inconclusive" is not evidence that a source is answering us. It does mean
 * this fires more readily on the kinds whose probes mostly resolve "unknown"
 * (LinkedIn/Indeed behind interstitials, SPA-rendered Workday tenants on the
 * HTML fallback) — which is the right bias for exactly those kinds.
 *
 * WORST-CASE REQUEST VOLUME against a tenant that refuses EVERYTHING:
 *
 *   requests/tick = (ABORT_AFTER + concurrency − 1) × attempts × calls-per-probe
 *
 * `concurrency − 1` is the siblings already dispatched when the Nth refusal
 * lands (the abort cannot un-send them). `attempts` = 1 + MAX_RETRIES = 3.
 * `calls-per-probe` is how many probeViaHttpStatus calls one refused probe
 * makes: 1 for workday (a CXS refusal deliberately skips the same-host HTML
 * fallback), 2 for greenhouse/lever (API, then the HTML fallback), 1 elsewhere.
 *
 *   workday      (conc 2, 1 call):  (3 + 2 − 1) × 3 × 1 = 12 of a 60 cap
 *   serial kinds (conc 1, 1 call):   3          × 3 × 1 =  9
 *   greenhouse   (conc 8, 2 calls): (3 + 8 − 1) × 3 × 2 = 60 of a 200 cap
 *
 * probeBatch is called per WATCHLIST (scheduler/jobs/job-watcher.ts), so a
 * batch is one tenant and those numbers are per tenant per tick. For the case
 * that matters — a permanently-403 Workday tenant like Boeing — the CXS breaker
 * trips inside the SAME tick, so the tenant then costs ZERO until the 6h
 * cooldown expires: 12 requests per 6h, i.e. 2/hour, or 0.4% of the 2026-07-31
 * incident rate. The pre-change figure was 3 requests per 6h (one per tick,
 * three ticks to trip).
 *
 * THIS BOUND DOES NOT COVER THE SPORADIC TENANT, which is the whole reason
 * SOFT_REFUSAL_RETRY_BUDGET exists — see there.
 */
const SOFT_REFUSAL_ABORT_AFTER = 3;

/**
 * Per-`probeBatch` ceiling on EXTRA attempts, shared by every probe in the
 * batch. Expressed as a fraction of `maxPerTick`.
 *
 * WHY A PER-PROBE CAP IS NOT A BOUND. SOFT_REFUSAL_MAX_RETRIES caps one probe
 * at 3 attempts, and SOFT_REFUSAL_ABORT_AFTER caps the batch — but only when
 * probes refuse CONSECUTIVELY. A tenant that refuses two attempts in three
 * never lets the run reach 3, so no abort ever fires and the real ceiling
 * becomes `maxPerTick × attempts × calls-per-probe`: measured at 140 requests
 * for a 60-posting workday batch, with theoretical ceilings of 180 (workday)
 * and 1,200 (greenhouse, 200 × 3 × 2). `maxPerTick` is documented as the "hard
 * cap per probeBatch() call" and it had silently become a cap on PROBES with
 * nothing capping REQUESTS — against a number deliberately cut 500 → 60 after
 * the 15-day Axiom IP block. That is precisely the class of drift that caused
 * the incident, so the bound is now enforced rather than described.
 *
 * WHY maxPerTick / 2. At Blue Origin's worst MEASURED first-attempt refusal
 * rate (4 of 12 ≈ 1/3, from a burst hotter than the current profile permits)
 * the expected extra attempts over N probes are N × (p + p²) = N × 0.44. Half
 * of maxPerTick covers that with ~14% headroom, so the sporadic tenant this
 * change exists for never actually hits the ceiling. Note the budget counts
 * ATTEMPTS, not probes, so it is spent by whoever needs it.
 *
 * WHEN IT RUNS OUT the degradation is graceful, not a cliff: probes keep
 * running, they simply stop retrying — i.e. exactly the pre-2026-08-02
 * behaviour — and any resulting refusals feed SOFT_REFUSAL_ABORT_AFTER, which
 * is the correct response to a tenant refusing at that rate. This is why a
 * shared budget beat the alternative of "abort after B total refusals": that
 * one re-creates the blackout at a cliff edge.
 *
 * RESULTING HARD CEILING, sporadic tenant:
 *   requests/tick ≤ maxPerTick × calls-per-probe + ceil(maxPerTick / 2)
 *   workday:    60 × 1 + 30 =  90  (was unbounded-in-practice at 180)
 *   greenhouse: 200 × 2 + 100 = 500  (was 1,200)
 *   linkedin:   30 × 1 + 15 =  45
 */
const SOFT_REFUSAL_RETRY_BUDGET = (maxPerTick: number): number =>
    Math.max(SOFT_REFUSAL_MAX_RETRIES, Math.ceil(maxPerTick / 2));

/**
 * Test seam — smokes drive the retry path dozens of times and the real backoff
 * would add ~10s to the pre-push gate for zero extra signal (their assertions
 * are on request counts and verdicts, never on timing). Production never calls
 * this; the worst a stray call can do is shorten a backoff.
 */
export function _setSoftRefusalBackoffForTests(ms: number): void {
    softRefusalBackoffMs = ms > 0 ? ms : SOFT_REFUSAL_BACKOFF_MS;
}

export type WatchlistKind = (typeof WATCHLIST_KINDS)[number];
export type LivenessResult = "alive" | "closed" | "unknown";

export interface ProbeInput {
    /** Map key for batch results. Same value as `JobPosting.externalId`. */
    externalId: string;
    sourceUrl: string;
    /**
     * Optional board-level identifier from the owning `Watchlist.config`, for
     * the kinds whose per-posting API is addressed as (board, posting) rather
     * than by posting id alone.
     *
     * Only `clearcompany` reads it today (its detail endpoint is
     * `/v1/<siteId>/<jobId>`, and the siteId appears nowhere in the posting
     * URL — see probeClearCompany). It is OPTIONAL because the other callers of
     * probeBatch (scripts/tests/debug/recover-false-closed.ts, the
     * close-detection audit probe) build ProbeInputs straight from JobPosting
     * rows and have no watchlist config in hand. A kind that needs it and
     * doesn't get it resolves "unknown" — never "closed".
     */
    boardKey?: string;
}

export interface ProbeProfile {
    /** Max in-flight probes for this kind. */
    concurrency: number;
    /** Sleep between consecutive hits to the same host (anti-bot throttling). */
    perHitDelayMs: number;
    /** Hard cap per probeBatch() call. Anything past the cap is reported "unknown". */
    maxPerTick: number;
    /** Per-probe network timeout. */
    timeoutMs: number;
}

/**
 * Per-ATS probe budgets. Tuned for: (a) source server politeness, (b) how
 * aggressively that source bot-detects, (c) realistic backlog sizes in the
 * current dataset. See docs/archive/close-detection-probe.md §Per-ATS probe profiles
 * for the spreadsheet.
 */
export const PROBE_PROFILES: Record<WatchlistKind, ProbeProfile> = {
    linkedin:        { concurrency: 1, perHitDelayMs: 1500, maxPerTick:  30, timeoutMs: 8000 },
    indeed:          { concurrency: 1, perHitDelayMs: 1500, maxPerTick:  30, timeoutMs: 8000 },
    // 2026-07-31: was { concurrency: 6, maxPerTick: 500, timeoutMs: 5000 } —
    // far too hot. Measured over 24h, that profile issued 11.5k probe GETs at
    // *nine times* the volume of the actual job-listing crawls (1.1k POSTs) and
    // returned 5,558 `unknown` vs 427 `alive`: ~93% waste. Workday answers a
    // hammered tenant with 403 (and, under sustained load, 500) rather than
    // 429, so the batch's back-off never tripped — see the status handling in
    // probeViaHttpStatus. The collateral damage was real: Axiom Space's own
    // CRAWL was 429-blocked for 15 days while its endpoint served 200s to a
    // cold request. Lower concurrency + a much smaller per-tick cap keeps the
    // shared IP in good standing; the C3 rolling cursor still reaches every
    // posting, just over more ticks. The longer timeout reflects the observed
    // p99 on the CXS detail endpoint (5s was clipping healthy responses).
    workday:         { concurrency: 2, perHitDelayMs:    0, maxPerTick:  60, timeoutMs: 8000 },
    greenhouse:      { concurrency: 8, perHitDelayMs:    0, maxPerTick: 200, timeoutMs: 4000 },
    lever:           { concurrency: 6, perHitDelayMs:    0, maxPerTick: 100, timeoutMs: 4000 },
    ashby:           { concurrency: 4, perHitDelayMs:  200, maxPerTick: 100, timeoutMs: 5000 },
    smartrecruiters: { concurrency: 4, perHitDelayMs:    0, maxPerTick: 100, timeoutMs: 5000 },
    workable:        { concurrency: 4, perHitDelayMs:    0, maxPerTick: 100, timeoutMs: 5000 },
    recruitee:       { concurrency: 4, perHitDelayMs:    0, maxPerTick: 100, timeoutMs: 5000 },
    personio:        { concurrency: 4, perHitDelayMs:    0, maxPerTick: 100, timeoutMs: 5000 },
    // 2026-08-02: was { concurrency: 4, perHitDelayMs: 0, maxPerTick: 100 }
    // back when clearcompany was on probeGeneric and every probe hit the
    // tenant's own SPA host. probeClearCompany now hits careers-api
    // .clearcompany.com — the SAME host lib/fetchers/clearcompany-fetcher.ts
    // crawls the job list from — so probe traffic and crawl traffic share one
    // budget, and starving the crawl to detect closures would be a bad trade.
    // A non-zero perHitDelayMs puts probeBatch in SERIAL mode (concurrency is
    // then inert, same as the ashby row), giving ~4 requests/sec worst case.
    // maxPerTick 50 drains the ~125-row stale backlog in ~3 ticks, which is
    // well inside the two-strike close window.
    clearcompany:    { concurrency: 2, perHitDelayMs:  250, maxPerTick:  50, timeoutMs: 6000 },
    "careers-page":  { concurrency: 3, perHitDelayMs:  500, maxPerTick:  50, timeoutMs: 6000 },
};

const LINKEDIN_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const POLITE_UA = "mission-control-watcher/1.0 (+https://mc.local; personal job-search agent)";

/**
 * Closure markers checked against (lowercased) response bodies for the
 * HTML-scraping kinds. Designed to grow.
 */
const LINKEDIN_CLOSED_MARKERS = [
    "no longer accepting applications",
    "job is no longer available",
    "this job is no longer available",
    "position is no longer",
    "position is no longer available",
    "this job has been removed",
    "this job has expired",
    "no longer active",
];
const LINKEDIN_ALIVE_MARKERS = [
    "top-card-layout",
    "description__text",
    "apply-button",
    "jobs-apply-button",
];
// Ashby renders the posting as a SPA whose initial state is embedded in a
// `window.__appData` JSON blob carrying a tier-4 `"isListed":<bool>` flag (the
// only liveness signal Ashby sends on purpose — see C0 audit / probeAshby's
// JSON-first path below). The string markers here are the tier-3 fallback for
// the rendered-banner case and for any page that omits the blob.
const ASHBY_CLOSED_MARKERS = [
    "posting could not be found",
    "this job is no longer",
    "this position is no longer",
    "this position has been filled",
    "no longer accepting applications",
    "this job posting is no longer available",
    "this position is no longer available",
];
// Stable structural strings present on a live Ashby posting page. Used to gate
// "alive" — a 200 that has neither a closed marker nor any of these (e.g. a
// consent / error interstitial) falls to "unknown" rather than "alive".
//
// `window.__appdata` was the first entry here until 2026-08-01 and had ZERO
// discriminating power: jobs.ashbyhq.com answers every path with 200, and the
// ~7KB not-found shell embeds the blob too (all fields null). So EVERY removed
// Ashby posting probed "alive" forever — measured on prod.db, ashby had closed
// 1 of 373 postings (0.3%) against greenhouse 43.8% and lever 35.6%. Removing
// it leaves `"islisted":true` as the real alive signal (the not-found shell has
// no isListed key at all). The two id/class markers below fire on neither the
// canonical jobs.ashbyhq.com page nor the shell — they are kept only for
// embedded / rendered board variants, and cost nothing as extra OR arms.
const ASHBY_ALIVE_MARKERS = [
    "\"islisted\":true",
    "ashby_jb_posting", // posting widget container id (embedded board variant)
    "application-form",
];
/**
 * Ashby's self-declared "my data layer is degraded" flag (2026-08-01).
 *
 * The SPA shell rendered during an Ashby maintenance window has EXACTLY the
 * not-found shape — `window.__appData` present, organization / posting /
 * jobBoard all null, nothing hydrated, no `isListed` — and the ONLY thing that
 * distinguishes it is the blob advertising the state itself (both captured
 * fixtures carry `"maintenanceMode":false`). It is not evidence about the
 * posting, so it must resolve "unknown", never "closed": a platform-wide
 * maintenance window would otherwise stamp/confirm closes across the whole
 * Ashby population, and false-closed rows never self-heal — the stale re-probe
 * excludes status="closed" and the C3 sweep selects only status="new", so
 * recovery is the manual recover-false-closed script, and a confirmed close
 * also cascades into auto-closing linked INTERESTED cards.
 *
 * The pattern is LEADING-QUOTE anchored so it stays keyed to the exact
 * `maintenanceMode` field and cannot match `schedulingMaintenanceMode`, a
 * different subsystem's flag that sits right next to it in the same blob.
 * Whitespace-tolerant like the workday CXS flag checks (the blob is minified
 * today, but don't depend on it).
 *
 * Read by probeAshby as the FIRST test in its callback — see the comment there
 * for why the position, not just the check, is the fix.
 */
const ASHBY_MAINTENANCE_RE = /"maintenancemode"\s*:\s*true/;
/**
 * The ONE host whose board root is closure evidence. `u.host.includes(
 * "ashbyhq.com")` was a substring test, so `status.ashbyhq.com`,
 * `www.ashbyhq.com` and anything else matching `*ashbyhq.com*` cleared it —
 * and every one of those has a 0–1-segment path, so a redirect to a status or
 * marketing holding page read as "posting removed" without the body ever being
 * consulted. Only the canonical board host parks dead postings at its root.
 */
const ASHBY_BOARD_HOST = "jobs.ashbyhq.com";
const WORKDAY_CLOSED_MARKERS = [
    "job is no longer",
    "this job is no longer available",
    "position has been filled",
    "this position has been filled",
    "no longer accepting applications",
    "posting has been removed",
    "the job posting you are looking for",
];
// Live Workday postings render a data-automation-id="jobPostingPage" container
// (server-side, before hydration). Gate "alive" on a real posting marker so a
// Cloudflare interstitial / login wall that slips past the redirect check
// doesn't read as a live posting. (The CXS JSON probe below is preferred when
// the URL is parseable; this is the HTML fallback's gate.)
const WORKDAY_ALIVE_MARKERS = [
    "jobpostingpage",           // data-automation-id="jobPostingPage"
    "data-automation-id=\"job", // jobPostingHeader / jobPostingDescription etc.
    "applybutton",              // data-automation-id="applyButton" / "adventureButton"
];
const INDEED_CLOSED_MARKERS = [
    "this job has expired",
    "no longer accepting applications",
    "this job posting is no longer available",
    "we couldn't find this job",
    "this job is no longer available",
    "this position has been filled",
    "position is no longer available",
];
const INDEED_ALIVE_MARKERS = [
    "jobsearch-jobinfoheader",
    "jobsearch-bodyContainer",
    "applybuttonwrapper",
    "indeedapplybutton",
];

/**
 * Release a response body we are never going to read.
 *
 * `withTimeout` clears its timer without aborting the controller, so under
 * undici an unconsumed body pins its connection until GC. The refusal path is
 * where that hurts most — it is the path taken when the host is already
 * struggling and connections are scarcest — and the 2026-08-02 retry work
 * multiplied it by up to 3× per probe. The other non-reading exits (unsafe
 * final URL, bare 404 → closed, non-OK, alive-without-a-body-check) get the
 * same treatment: it is the same one-liner and leaving three of four unfixed
 * next to the helper only invites the question.
 */
async function discardBody(res: Response): Promise<void> {
    try { await res.body?.cancel(); } catch { /* already consumed / errored */ }
}

/** Run `fn` with an AbortSignal that fires after `timeoutMs`. */
async function withTimeout<T>(timeoutMs: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T | "timeout"> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        return await fn(ctrl.signal);
    } catch (e: unknown) {
        if (e instanceof Error && (e.name === "AbortError" || /aborted/i.test(e.message))) return "timeout";
        throw e;
    } finally {
        clearTimeout(t);
    }
}

/**
 * P3.1b — max redirects followed per probe. A chain longer than this is
 * ambiguity (redirect loop / tracking maze), never closure evidence → the
 * probe resolves "unknown".
 */
const MAX_REDIRECT_HOPS = 5;

/**
 * P3.1b — SSRF-safe redirect follower. `redirect: "follow"` only let us
 * validate the FINAL URL after the fact: an intermediate hop through an
 * internal host (SSRF via open redirect on the source) had already been
 * fetched by the time `assertSafeResponseUrl` ran. This fetches with
 * `redirect: "manual"`, resolves each Location against the current URL, and
 * runs the URL guard on EVERY hop target before following it.
 *
 * Returns the final (non-3xx-or-no-Location) response plus the URL it was
 * requested from, or "unknown" when the chain is unfollowable (guard trip,
 * unparseable Location, over the hop cap, network throw).
 */
async function fetchWithGuardedRedirects(
    url: string,
    signal: AbortSignal,
    headers: Record<string, string>,
): Promise<{ res: Response; requestedUrl: string } | "unknown"> {
    let current = url;
    for (let hop = 0; ; hop++) {
        let res: Response;
        try {
            // record: false — the outcome is recorded ONCE per probe by
            // recordProbeOutcome (below), classified by VERDICT rather than by
            // raw HTTP status. Letting loggedFetch record here counted every
            // redirect hop separately AND scored a 404 as a fetcher error.
            res = await loggedFetch(current, { method: "GET", redirect: "manual", signal, headers }, { record: false });
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.warn(`[liveness] fetch threw for ${current}: ${msg}`);
            return "unknown";
        }
        const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
        if (location === null) return { res, requestedUrl: current };
        // Drop the 3xx body — we only needed the Location header.
        try { await res.body?.cancel(); } catch { /* ignore */ }
        if (hop >= MAX_REDIRECT_HOPS) {
            console.warn(`[liveness] redirect chain from ${url} exceeded ${MAX_REDIRECT_HOPS} hops — unknown`);
            return "unknown";
        }
        let next: URL;
        try {
            next = new URL(location, current);
        } catch {
            console.warn(`[liveness] unparseable redirect Location from ${current}: ${location}`);
            return "unknown";
        }
        try {
            assertExternalHttpUrl(next.toString());
        } catch (e) {
            if (e instanceof UnsafeURLError) {
                console.warn(`[liveness] unsafe redirect target from ${current}: ${e.message}`);
                return "unknown";
            }
            throw e;
        }
        current = next.toString();
    }
}

/**
 * Generic HTTP-status probe used by every kind whose "removed" state shows up
 * as 404/410. The `extraClosedCheck` hook lets HTML-scraping kinds (linkedin,
 * ashby, workday) inspect the body / final URL for closure markers when the
 * status is 200.
 *
 * Since 2026-08-02 a SOFT refusal (403) is retried up to
 * SOFT_REFUSAL_MAX_RETRIES times with jittered backoff, INSIDE the caller's
 * `timeoutMs` budget and against `ctx.takeRetry`'s batch-wide allowance, before
 * `onRateLimit` fires — so a sporadic 403 costs a couple of requests instead of
 * the rest of the tick. The retry lives here, in the shared helper, rather than
 * in probeWorkday where the evidence was gathered: the mechanism (a load-shaped
 * 403 that clears on its own) is not Workday-specific, and one code path beats
 * a per-kind copy. The trade-off, stated plainly: for the kinds where a 403 is
 * a hard bot-block that will never clear (LinkedIn / Indeed behind Cloudflare)
 * the retries buy nothing — but they are capped at 2 extra requests on a probe
 * that had already failed, paced no faster than the profile's own
 * `perHitDelayMs`, and drawn from the batch's shared budget.
 *
 * THE REFUSAL IS LATCHED, NOT OVERWRITTEN, and that is load-bearing. The first
 * version reset the status at the top of every attempt and only reported a
 * refusal when the LAST attempt was itself a refusal — so 403-then-timeout,
 * 403-then-network-error and 403-then-SSRF-trip all returned "unknown" carrying
 * no refusal signal at all. Everything downstream then failed open at once:
 * probeWorkday's `refused` stayed false so the CXS breaker never tripped AND
 * the same-host HTML fallback ran (the one request the design says must never
 * follow a refusal), and probeBatch saw neither a refusal nor a verdict so its
 * run neither advanced nor cleared. Measured on 10 postings at
 * `timeoutMs: 1100` with a 403-then-hang fixture: 30 requests and 5.5s with no
 * breaker trip and no abort, where the pre-2026-08-02 code spent 1 request and
 * aborted — a straight regression, and 200 → 403 → 500 degradation under load
 * is exactly the progression the workday row of PROBE_PROFILES documents. A
 * probe that saw a refusal and then failed to reach a verdict bought no
 * information and must still count as a refusal.
 */
async function probeViaHttpStatus(
    url: string,
    ctx: ProbeContext,
    userAgent: string,
    extraClosedCheck?: (final: { finalUrl: string; bodyLower: string }) => LivenessResult | null,
    /**
     * Optional hook that DOWNGRADES the default `404/410 → closed` rule by
     * letting the caller inspect the not-found body first.
     *
     * Every other kind wants the default: a 404 from Greenhouse's or Lever's
     * API means the posting is gone, full stop. ClearCompany is the exception
     * — its API answers BOTH "this board has no such requisition" (posting-
     * level, a ProblemDetails JSON body) and "I don't know this board at all"
     * (board-level, an EMPTY body) with a bare 404, and only the first is
     * evidence about the posting. See probeClearCompany.
     *
     * Absent ⇒ behavior is exactly as before (404/410 ⇒ closed), so this is
     * inert for every existing caller.
     */
    notFoundCheck?: (nf: { status: number; bodyLower: string }) => LivenessResult,
): Promise<LivenessResult> {
    try {
        assertExternalHttpUrl(url);
    } catch (e) {
        if (e instanceof UnsafeURLError) return "unknown";
        throw e;
    }
    // One SHARED deadline across every attempt. The retry loop below must not
    // let a probe run past the profile's timeout budget, so each attempt gets
    // whatever is left rather than a fresh `timeoutMs`.
    const deadline = Date.now() + ctx.timeoutMs;
    // LATCHED across attempts — never cleared once set. See the note on this
    // function for the regression that per-attempt clearing caused. Recorded
    // here rather than by calling `onRateLimit` inline because that callback is
    // the batch-level abort signal and must fire only after the retries are
    // spent; firing it per-attempt aborts the batch on the first sporadic 403.
    let lastRefusalStatus = 0;
    let result: LivenessResult | "rate-limited" | "timeout" = "unknown";
    for (let attempt = 0; ; attempt++) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) { result = "timeout"; break; }
        result = await withTimeout(remaining, async (signal) => {
            // P3.1b — manual, per-hop-guarded redirect loop (never redirect:"follow").
            const followed = await fetchWithGuardedRedirects(url, signal, {
                "User-Agent": userAgent,
                "Accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.5",
                "Accept-Language": "en-US,en;q=0.9",
            });
            if (followed === "unknown") return "unknown" as LivenessResult;
            const { res, requestedUrl } = followed;
            // Belt-and-braces: re-validate the response's reported URL too. Every
            // hop was already guarded above, but some fetch impls populate
            // `res.url` beyond what we requested — refuse to conclude from an
            // internal target either way.
            try {
                assertSafeResponseUrl(res);
            } catch (e) {
                if (e instanceof UnsafeURLError) {
                    console.warn(`[liveness] unsafe redirect target from ${url}: ${e.message}`);
                    await discardBody(res);
                    return "unknown" as LivenessResult;
                }
                throw e;
            }
            if (BACKOFF_STATUSES(res.status)) {
                // Source refusing us (429 / 403 / 5xx). Latch which status so
                // the retry decision below — and, if the retries run out,
                // probeBatch's soft/hard split — can tell them apart. Never
                // closure evidence: see the note on BACKOFF_STATUSES.
                lastRefusalStatus = res.status;
                await discardBody(res);
                return "rate-limited" as const;
            }
            if (res.status === 404 || res.status === 410) {
                if (!notFoundCheck) { await discardBody(res); return "closed" as LivenessResult; }
                const nfBody = await res.text().catch(() => "");
                return notFoundCheck({ status: res.status, bodyLower: nfBody.toLowerCase() });
            }
            if (!res.ok) { await discardBody(res); return "unknown" as LivenessResult; }

            // 2xx — let the optional extra check inspect body / final URL.
            if (extraClosedCheck) {
                const text = await res.text().catch(() => "");
                const finalUrl = res.url || requestedUrl;
                const verdict = extraClosedCheck({ finalUrl, bodyLower: text.toLowerCase() });
                if (verdict) return verdict;
            } else {
                await discardBody(res);
            }
            return "alive" as LivenessResult;
        });
        // Anything that is not a refusal ENDS the loop — including a timeout,
        // which is NOT retried: it already consumed the budget the retries would
        // have to come out of, and a slow host is not the sporadic-403 failure
        // this loop exists to absorb. Note `lastRefusalStatus` survives this
        // break, so an earlier 403 is still reported below.
        if (result !== "rate-limited") break;
        if (attempt >= SOFT_REFUSAL_MAX_RETRIES) break;
        // 429 / 5xx are HARD — retrying them is counterproductive (see
        // SOFT_REFUSAL_STATUSES). Only the ambiguous 403 buys another attempt.
        if (!SOFT_REFUSAL_STATUSES(lastRefusalStatus)) break;
        const jittered = (softRefusalBackoffMs << attempt) * (1 + Math.random());
        // Never faster than the profile's own same-host pacing.
        const backoff = Math.max(jittered, ctx.minRetryDelayMs ?? 0);
        // Retries live INSIDE the caller's timeout budget, never past it.
        if (deadline - Date.now() - backoff < SOFT_REFUSAL_MIN_ATTEMPT_MS) break;
        // Batch-wide allowance, taken LAST — after every other reason to bail
        // has been ruled out — so a token is never burned on a retry that then
        // doesn't happen, and never on wall-clock we were not going to spend.
        // Absent ⇒ unbudgeted (see ProbeContext).
        if (ctx.takeRetry && !ctx.takeRetry()) break;
        await sleep(backoff);
    }
    // Report a refusal whenever one was SEEN and the probe did not go on to
    // reach real evidence. The `alive`/`closed` exemption is what lets a
    // sporadic 403 that a retry recovered from cost the batch nothing and
    // (for workday) cost the per-tenant CXS breaker nothing; everything else —
    // refusal-then-timeout, refusal-then-throw, refusal-then-ambiguous-200 —
    // still counts, because none of it is evidence that the source is
    // answering us.
    const reachedEvidence = result === "alive" || result === "closed";
    if (lastRefusalStatus !== 0 && !reachedEvidence) ctx.onRateLimit?.(lastRefusalStatus);
    const verdict: LivenessResult = result === "timeout" || result === "rate-limited" ? "unknown" : result;
    // One health row per PROBE, not per attempt — the retries are one upstream
    // touch as far as the Fetcher Health card is concerned (loggedFetch already
    // runs with `record: false` for the same reason).
    recordProbeOutcome(url, verdict);
    return verdict;
}

/**
 * Fetcher-health attribution for ONE probe — meaning the whole probe, including
 * any soft-refusal retries it made. Called once, from the bottom of
 * probeViaHttpStatus, so a retried 403 is one row and not three.
 *
 * A probe that reaches a verdict is a SUCCESSFUL upstream touch — including
 * "closed", which is a 404/410 and is the whole point of the probe gate.
 * Recording the raw HTTP status (what loggedFetch does by default) meant every
 * correctly-detected closed posting landed on the Fetcher Health card as a
 * fetcher ERROR: Greenhouse's 146 "errors" over 24h were ~120 successful
 * close-detections, and the card read ~30% unhealthy while 45 of 48 watchlists
 * were fetching fine. Only an INCONCLUSIVE probe (refused, timed out, or
 * ambiguous) is a real error.
 *
 * Best-effort like every other recordFetchOutcome caller — never throws.
 */
function recordProbeOutcome(url: string, verdict: LivenessResult): void {
    recordFetchOutcome(hostOf(url), verdict === "unknown" ? "error" : "ok");
}

// ─── OQ4b — positive-evidence redirect classification ─────────────────────
//
// Pre-2026-06-12, an off-path redirect (final URL no longer on the posting
// path) was unconditionally treated as closure evidence by the LinkedIn /
// Indeed / Workday-HTML probes. That false-closes through interstitials: an
// authwall / login / signup / bot-challenge / consent redirect moves us off
// the posting path without saying anything about the posting. New policy: an
// off-path redirect alone is NEVER "closed". It only counts as closure
// evidence when
//   (a) the final URL is the board's OWN jobs-search / root surface (the
//       canonical place boards park requests for dead postings — small
//       explicit allowlist per board below), or
//   (b) a body closed-marker hits on whatever page we landed on.
// Anything else (auth gates, challenges, unrecognized surfaces) → "unknown",
// so the row is left alone and re-probed next tick.

/** Path fragments that identify auth / interstitial surfaces — never closure evidence. */
const AUTH_INTERSTITIAL_PATH_RE = /(authwall|login|signin|sign-in|signup|sign-up|register|checkpoint|challenge|captcha|consent|verify)/i;

/** LinkedIn's own jobs-search / root surface (dead postings get parked here). */
function isLinkedinSearchSurface(u: URL): boolean {
    if (!/(^|\.)linkedin\.com$/i.test(u.hostname)) return false;
    const path = u.pathname.replace(/\/+$/, "") || "/";
    return path === "/" || path === "/jobs" || path.startsWith("/jobs/search");
}

/** Indeed's own jobs-search / homepage surface. */
function isIndeedSearchSurface(u: URL): boolean {
    if (!/(^|\.)indeed\.com$/i.test(u.hostname)) return false;
    const path = u.pathname.replace(/\/+$/, "") || "/";
    return path === "/" || path === "/jobs";
}

/**
 * Workday tenant board root / search surface: "/", "/<site>" or
 * "/<locale>/<site>" on a *.myworkdayjobs.com host — never anything deeper
 * (auth flows and error stubs are screened out by AUTH_INTERSTITIAL_PATH_RE
 * before this runs).
 */
function isWorkdaySearchSurface(u: URL): boolean {
    if (!/\.myworkdayjobs\.com$/i.test(u.hostname)) return false;
    const segments = u.pathname.split("/").filter(Boolean);
    return segments.length <= 2;
}

/**
 * Classify a 200 whose final URL drifted off the posting path. Order matters:
 * a body closed-marker is positive evidence wherever we landed (b); auth /
 * interstitial surfaces are ambiguity; the board's own search/root surface is
 * genuine closure evidence (a); everything else is "unknown".
 */
function offPathRedirectVerdict(
    finalUrl: string,
    bodyLower: string,
    closedMarkers: string[],
    isBoardSearchSurface: (u: URL) => boolean,
): LivenessResult {
    for (const m of closedMarkers) {
        if (bodyLower.includes(m)) return "closed";
    }
    let u: URL;
    try { u = new URL(finalUrl); } catch { return "unknown"; }
    if (AUTH_INTERSTITIAL_PATH_RE.test(u.pathname)) return "unknown";
    if (isBoardSearchSurface(u)) return "closed";
    return "unknown";
}

// ─── Per-kind probes ──────────────────────────────────────────────────────

async function probeLinkedin(p: ProbeInput, ctx: ProbeContext): Promise<LivenessResult> {
    return probeViaHttpStatus(p.sourceUrl, ctx, LINKEDIN_UA, ({ finalUrl, bodyLower }) => {
        // OQ4b — redirected off the posting path. Closed only on positive
        // evidence (LinkedIn's own jobs-search/root surface, or a body
        // marker); authwall / login / checkpoint interstitials → "unknown".
        if (!finalUrl.includes("/jobs/view/")) {
            return offPathRedirectVerdict(finalUrl, bodyLower, LINKEDIN_CLOSED_MARKERS, isLinkedinSearchSurface);
        }
        for (const m of LINKEDIN_CLOSED_MARKERS) {
            if (bodyLower.includes(m)) return "closed";
        }
        // Require positive evidence of an actual job page before declaring
        // alive — otherwise an interstitial / consent page reads as "alive".
        const hasAliveMarker = LINKEDIN_ALIVE_MARKERS.some(m => bodyLower.includes(m));
        if (!hasAliveMarker) return "unknown";
        return null; // fall through to "alive"
    });
}

async function probeIndeed(p: ProbeInput, ctx: ProbeContext): Promise<LivenessResult> {
    // Indeed UA-sniffs the same way LinkedIn / Workday do — Cloudflare flags
    // anything that doesn't look like a real browser.
    return probeViaHttpStatus(p.sourceUrl, ctx, LINKEDIN_UA, ({ finalUrl, bodyLower }) => {
        // OQ4b — off /viewjob entirely. Closed only when Indeed parked us on
        // its own search / homepage surface or a body marker hits; auth /
        // challenge interstitials → "unknown".
        if (!finalUrl.includes("/viewjob")) {
            return offPathRedirectVerdict(finalUrl, bodyLower, INDEED_CLOSED_MARKERS, isIndeedSearchSurface);
        }
        for (const m of INDEED_CLOSED_MARKERS) {
            if (bodyLower.includes(m)) return "closed";
        }
        // Same shape as LinkedIn — require an alive marker so a Cloudflare
        // interstitial doesn't read as a live posting.
        const hasAliveMarker = INDEED_ALIVE_MARKERS.some(m => bodyLower.includes(m));
        if (!hasAliveMarker) return "unknown";
        return null;
    });
}

const GREENHOUSE_URL_RE = /^https?:\/\/[^/]+greenhouse\.io\/([^/]+)\/jobs\/(\d+)/i;
async function probeGreenhouse(p: ProbeInput, ctx: ProbeContext): Promise<LivenessResult> {
    const m = p.sourceUrl.match(GREENHOUSE_URL_RE);
    if (m) {
        const slug = m[1];
        const jobId = m[2];
        const apiUrl = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs/${encodeURIComponent(jobId)}`;
        const r = await probeViaHttpStatus(apiUrl, ctx, POLITE_UA);
        if (r !== "unknown") return r;
    }
    // Fall back to probing the canonical HTML page.
    return probeViaHttpStatus(p.sourceUrl, ctx, POLITE_UA);
}

const LEVER_URL_RE = /^https?:\/\/jobs\.lever\.co\/([^/]+)\/([0-9a-f-]{16,})/i;
async function probeLever(p: ProbeInput, ctx: ProbeContext): Promise<LivenessResult> {
    const m = p.sourceUrl.match(LEVER_URL_RE);
    if (m) {
        const slug = m[1];
        const postingId = m[2];
        const apiUrl = `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}/${encodeURIComponent(postingId)}`;
        const r = await probeViaHttpStatus(apiUrl, ctx, POLITE_UA);
        if (r !== "unknown") return r;
    }
    return probeViaHttpStatus(p.sourceUrl, ctx, POLITE_UA);
}

/**
 * ClearCompany posting URLs are the board's `applyLink`:
 *   https://<shortname>.clearcompany.com/careers/jobs/<jobId>/apply
 * `jobId` is the only part we need; `<shortname>` is a tenant vanity host and
 * is deliberately NOT used to address the API (see probeClearCompany).
 */
const CLEARCOMPANY_URL_RE = /^https?:\/\/[^/]+\.clearcompany\.com\/careers\/jobs\/([0-9a-f-]{16,})(?:\/|$)/i;

/**
 * ClearCompany — tier-4 structured probe (2026-08-02).
 *
 * WHY THIS EXISTS. clearcompany was the last kind still on probeGeneric, and
 * that was actively wrong rather than merely weak: `<shortname>.clearcompany
 * .com` serves an empty client-rendered SPA shell with HTTP 200 for EVERY job
 * path, so probeGeneric returned "alive" unconditionally. Measured on prod.db
 * 2026-08-01: 245 postings, 0 ever closed, `pendingClosedAt` never once
 * stamped. The shell is byte-identical (11,027 bytes) for a live posting, a
 * long-removed one, and a syntactically bogus id, and contains neither the job
 * id nor the title — so no body heuristic can ever work here, and the previous
 * note in probeGeneric correctly refused to invent one.
 *
 * THE SIGNAL. The board's own career site is a thin client over a public JSON
 * API — the same API `lib/fetchers/clearcompany-fetcher.ts` already crawls for
 * the job LIST — which also exposes a per-requisition DETAIL resource:
 *
 *   GET https://careers-api.clearcompany.com/v1/<siteId>/<jobId>
 *
 * Validated 2026-08-02 against Firefly Aerospace (the only ClearCompany tenant
 * in the DB) over a 10-posting stratified sample whose expected verdict was
 * established INDEPENDENTLY of the probe, by cross-referencing the live board
 * list against prod.db. All 10 agreed exactly:
 *   - 5 live postings           → 200 + the full posting JSON
 *   - 4 postings absent from the board → 404
 *   - 1 deliberately bogus job id      → 404
 * Reproduce with `scripts/tests/debug/clearcompany-probe-audit.ts detail`.
 *
 * THREE OF THOSE FIVE "alive" ROWS ARE THE POINT. Their `lastSeenAt` was 64
 * days old — i.e. job-watcher had them queued as close candidates — while the
 * posting was demonstrably still on the live board. They are exactly what a
 * naive "stale ⇒ closed" rule (or a `probeGeneric` that had 404'd instead of
 * 200'd) would have false-closed.
 *
 * WHY THIS IS INDEPENDENT EVIDENCE, not a restatement of the fetcher's view.
 * The gate exists because the FETCHER's picture of a board can be incomplete.
 * The detail endpoint asks about ONE requisition and cannot be truncated,
 * paginated or filtered — the list endpoint demonstrably can: Firefly's list
 * response is ~1.3 MB and TWO of five live fetches during this investigation
 * came back truncated mid-stream. A posting dropped by a partial list read
 * still answers 200 here, so it re-probes "alive" instead of closing.
 *
 * WHY THE 404 MUST CARRY A BODY. This is the mass-false-close interlock, and
 * it is the ClearCompany analogue of Ashby's maintenanceMode bail-out. The API
 * returns a bare 404 for two very different things:
 *   - POSTING-level ("this board has no such requisition") → 404 WITH an
 *     RFC 7231 ProblemDetails JSON body (161 bytes, `"status":404`);
 *   - BOARD-level ("I don't know this siteId at all") → 404 with an EMPTY body,
 *     because the request never reaches the controller.
 * Confirmed reproducible against two different bogus siteIds. Closing on a
 * bare 404 would mean that the day ClearCompany rotates or retires a tenant's
 * siteId, every posting on that board closes at once — and a confirmed close
 * cascades into auto-closing linked application cards and never self-heals.
 * So an empty 404 resolves "unknown".
 *
 * Note this is strictly SAFER than the plain `404 ⇒ closed` rule that
 * probeGreenhouse and probeLever use: if ClearCompany ever starts sending a
 * body on board-level 404s too, we lose the interlock but degrade to their
 * behavior; if it ever stops sending one on posting-level 404s, we close
 * nothing — which is exactly today's status quo. Neither direction can
 * over-close.
 *
 * WHY siteId COMES FROM THE WATCHLIST. The siteId appears nowhere in the
 * posting URL, nowhere in the SPA shell, and is not derivable from the
 * `<shortname>` host — it is a separate UUID that lives in
 * `Watchlist.config.boardSlug` (the same value the fetcher crawls with). It is
 * threaded in as `ProbeInput.boardKey`. A rejected alternative was to scrape it
 * from the tenant's careers landing page and memoize per host; that adds a
 * request, a cache, and a scrape to learn something the caller already knows.
 * No boardKey ⇒ "unknown".
 *
 * A REJECTED SECOND SIGNAL, recorded so it is not re-discovered as an
 * improvement: the career site's own job-detail view XHRs
 * `<host>/api/v1/careers/jobs/<jobId>/posting-url` (requires an `API-ShortName`
 * header) and redirects to an HRMDirect requisition page. It loses on every
 * axis — two requests instead of one, and hop 1 does NOT discriminate (a
 * REMOVED posting still answers 200 with a posting-url; only a wholly unknown
 * id 404s), so removal detection lands back on an HTML marker ("Oops! The
 * position you're looking for does not exist") served by a host that visibly
 * degrades under rapid fire. `clearcompany-probe-audit.ts twohop` still runs it.
 */
async function probeClearCompany(p: ProbeInput, ctx: ProbeContext): Promise<LivenessResult> {
    const m = p.sourceUrl.match(CLEARCOMPANY_URL_RE);
    // No boardKey (a caller with no watchlist config) or a non-canonical URL:
    // there is no probe to run. Deliberately NOT falling back to probeGeneric —
    // on this kind that is a guaranteed FALSE "alive" (the 200-for-everything
    // SPA shell), which is the bug being fixed.
    if (!m || !p.boardKey) return "unknown";
    const jobId = m[1].toLowerCase();
    const apiUrl = `https://careers-api.clearcompany.com/v1/${encodeURIComponent(p.boardKey)}/${encodeURIComponent(jobId)}`;
    // The id-echo requirement: a 200 only means "alive" if the payload is
    // actually THIS requisition. Guards against a future generic 200 (an empty
    // envelope, a board-level summary, an interstitial) reading as a live
    // posting. Whitespace-tolerant on a minified payload, same style as the
    // Workday CXS and Ashby flag checks.
    const idEcho = new RegExp(`"id"\\s*:\\s*"${jobId.replace(/[^0-9a-f-]/gi, "")}"`);
    return probeViaHttpStatus(apiUrl, ctx, POLITE_UA, ({ bodyLower }) => {
        if (idEcho.test(bodyLower)) return "alive";
        return "unknown";
    }, ({ bodyLower }) => {
        // Posting-level 404 carries a ProblemDetails body; board-level 404 is
        // empty. Only the former is evidence about this posting.
        if (bodyLower.trim().length === 0) {
            console.warn(`[liveness] clearcompany: empty 404 body for ${apiUrl} — board-level not-found (bad/rotated siteId?), not closure evidence`);
            return "unknown";
        }
        return "closed";
    });
}

/**
 * Ashby's "I don't know this posting" shell (2026-08-01).
 *
 * jobs.ashbyhq.com answers EVERY path with HTTP 200 — there is no 404 to read.
 * A live posting is SERVER-RENDERED (~49KB) with `window.__appData.organization`
 * and `.posting` both hydrated plus `"isListed":true`. Anything Ashby cannot
 * resolve gets a ~7KB shell whose blob has `organization`, `posting` AND
 * `jobBoard` all null. Verified 2026-08-01 against three live fetches: a live
 * posting, a posting under an org that no longer exists (cosmos), and a bogus
 * posting id under an org that DOES exist. The last two are byte-identical
 * (modulo the per-response CSP nonce) — which is what makes this check cover
 * the real case, a posting removed from a still-active board, and not just
 * whole boards disappearing.
 *
 * WHY THIS CANNOT MASS-FALSE-CLOSE. Four conditions must hold at once, and a
 * live posting body fails three of them:
 *   1. the `window.__appData` anchor is present  — proves this is the Ashby SPA
 *      shell and not an interstitial / CDN error page that happens to be short;
 *   2. organization / posting / jobBoard are ALL null. Only the first two
 *      discriminate today (`jobBoard` is null on the live page too, so it is a
 *      shape assertion, not evidence — do not "simplify" it into a signal). It
 *      is required anyway because an extra conjunct can only make closing
 *      HARDER, and if Ashby ever starts hydrating jobBoard for boards it can
 *      resolve, this check tightens itself instead of silently over-closing;
 *   3. NO hydrated Ashby entity appears anywhere in the body — the negative
 *      interlock. `"organization":{` / `"posting":{` on a live page trips this
 *      even if a description blob elsewhere contained a stray null literal;
 *   4. no `"isListed":true` anywhere — never conclude "removed" from a body
 *      that also carries a positive liveness claim.
 *
 * The maintenance bail-out is deliberately NOT here. It lived inside this
 * function from 2026-08-01 until 2026-08-02, which made it dead weight: this
 * is only the THIRD of probeAshby's four "closed" exits, so the board-root
 * redirect and the `"isListed":false` flag both reached "closed" without ever
 * consulting it. It now runs once at the TOP of probeAshby's callback, gating
 * all four. Do not re-add a copy here — one place to reason about beats two
 * that can drift, and a second copy would re-create the illusion that guarding
 * this function guards the probe.
 *
 * Residual risk, stated honestly: if Ashby ever stopped server-rendering the
 * posting into the shell, live and dead pages would become indistinguishable
 * from HTML alone and this WOULD over-close. No body heuristic can defend
 * against that (it is exactly why clearcompany is left unprobed — see the note
 * on probeGeneric). What contains it is the two-strike rule in job-watcher:
 * one "closed" only stamps pendingClosedAt, so a transient shape change costs
 * nothing, and the 0.3%→expected close-rate jump would be visible immediately.
 */
function isAshbyNotFoundShell(bodyLower: string): boolean {
    if (!bodyLower.includes("window.__appdata")) return false;
    // NOTE: the maintenanceMode bail-out is NOT repeated here — probeAshby
    // checks it before any exit can be reached. See the note above.
    // Positive: the three documented nulls (blob is minified, but tolerate
    // whitespace the same way the workday CXS flag checks do).
    const allNull = /"organization"\s*:\s*null/.test(bodyLower)
        && /"posting"\s*:\s*null/.test(bodyLower)
        && /"jobboard"\s*:\s*null/.test(bodyLower);
    if (!allNull) return false;
    // Negative interlock: any hydrated entity, or any positive listing claim,
    // means this is NOT the not-found shell — fall through to "unknown".
    if (/"organization"\s*:\s*\{/.test(bodyLower)) return false;
    if (/"posting"\s*:\s*\{/.test(bodyLower)) return false;
    if (/"islisted"\s*:\s*true/.test(bodyLower)) return false;
    return true;
}

async function probeAshby(p: ProbeInput, ctx: ProbeContext): Promise<LivenessResult> {
    return probeViaHttpStatus(p.sourceUrl, ctx, POLITE_UA, ({ finalUrl, bodyLower }) => {
        // ── Maintenance bail-out — FIRST, and that position is the point ──
        // Ashby says "my data layer is degraded" and nothing about this
        // posting, so NO exit below may reach "closed" on such a body. This
        // check shipped inside isAshbyNotFoundShell, which is only the third
        // of the four "closed" exits here — the board-root redirect (which
        // runs before any body is read) and the `"isListed":false` flag both
        // bypassed it entirely, so the protection did not exist. One gate,
        // above all four exits, is the only placement that actually holds.
        if (ASHBY_MAINTENANCE_RE.test(bodyLower)) return "unknown";
        // Redirected to the bare board root (no posting-id segment) → closed.
        // Posting URLs are jobs.ashbyhq.com/<slug>/<uuid>; board-root is /<slug>.
        // Host must match ASHBY_BOARD_HOST EXACTLY — a redirect to status. /
        // www. / any other host is not evidence the posting was removed, so it
        // falls through to the body checks and, failing those, "unknown".
        try {
            const u = new URL(finalUrl);
            const segments = u.pathname.split("/").filter(Boolean);
            if (u.hostname === ASHBY_BOARD_HOST && segments.length < 2) return "closed";
        } catch { /* ignore */ }
        // C2 — tier-4 structured state. Ashby embeds the posting's open/closed
        // flag in the SPA's `window.__appData` JSON as `"isListed":<bool>`
        // (confirmed against the live page + the public posting-api job-board
        // payload, C0 audit 2026-06-09). Trust it over the HTML heuristics when
        // present: an unlisted posting is closed; an explicitly-listed one is a
        // strong alive signal (handled below via the alive-marker gate, which
        // includes `"islisted":true`). The flag is whitespace-insensitive in
        // the minified blob, so match both compact forms.
        if (bodyLower.includes("\"islisted\":false") || bodyLower.includes("\"islisted\": false")) return "closed";
        // Ashby never 404s — the not-found shell IS the removal signal. See
        // isAshbyNotFoundShell for why this cannot mass-false-close.
        if (isAshbyNotFoundShell(bodyLower)) return "closed";
        for (const m of ASHBY_CLOSED_MARKERS) {
            if (bodyLower.includes(m)) return "closed";
        }
        // C1 — require positive evidence of a real posting page before calling
        // a 200 "alive". Mirrors the LinkedIn/Indeed gate: a consent/error
        // interstitial that lacks both a closed marker AND any alive marker is
        // ambiguous → "unknown" (re-probe next tick) rather than a false alive.
        const hasAliveMarker = ASHBY_ALIVE_MARKERS.some(m => bodyLower.includes(m));
        if (!hasAliveMarker) return "unknown";
        return null;
    });
}

/**
 * Workday source URLs look like
 *   https://<tenant>.<dc>.myworkdayjobs.com/<locale>/<site>/job/<loc>/<title>_<req>
 * Workday's own SPA fetches the posting through the CXS detail endpoint
 *   https://<host>/wday/cxs/<tenant>/<site>/job/<loc>/<title>_<req>
 * which returns structured JSON: a removed posting 404s, a live one returns
 * 200 with `jobPostingInfo.posted` / `canApply` booleans (C2 tier-4 — the only
 * liveness signal Workday sends on purpose; confirmed via C0 audit 2026-06-09).
 * Returns null when the URL doesn't fit the canonical shape (so the caller
 * falls back to the HTML probe).
 */
const WORKDAY_HOST_RE = /^([a-z0-9-]+)\.[a-z0-9-]+\.myworkdayjobs\.com$/i;
function deriveWorkdayCxsUrl(sourceUrl: string): string | null {
    let u: URL;
    try { u = new URL(sourceUrl); } catch { return null; }
    const hostMatch = u.host.match(WORKDAY_HOST_RE);
    if (!hostMatch) return null;
    const tenant = hostMatch[1];
    const segs = u.pathname.split("/").filter(Boolean);
    // Expect [locale, site, "job", ...rest]; need at least the "job" segment.
    const jobIdx = segs.indexOf("job");
    if (jobIdx < 1 || jobIdx === segs.length - 1) return null; // no site before, or nothing after "job"
    const site = segs[jobIdx - 1];
    const jobPath = segs.slice(jobIdx).join("/"); // "job/<loc>/<title>_<req>"
    return `https://${u.host}/wday/cxs/${encodeURIComponent(tenant)}/${encodeURIComponent(site)}/${jobPath}`;
}

/**
 * Per-tenant CXS availability breaker (2026-07-31).
 *
 * Some Workday tenants serve `403 {"errorCode":"S22","message":"permission
 * denied"}` on the CXS job-DETAIL endpoint permanently — their jobs-LIST
 * endpoint answers 200 fine, so the crawl works and only close-detection is
 * blocked. Measured over 24h: boeing (wd1) returned 0 `alive` from 2,298
 * probes, maxar (wd1) 54 from 862; both still 403 at concurrency 1 with full
 * browser headers, so it is tenant/DC configuration, not our request rate.
 *
 * Without a breaker those probes are unwinnable-but-eternal: every tick pays
 * requests that cannot produce a verdict, and — because a low-volume tenant
 * like Maxar only crawls ~3 pages — those failures dominate its Fetcher Health
 * row forever. After WORKDAY_CXS_TRIP_AFTER consecutive refusals a tenant's
 * CXS is skipped entirely (no network at all) for WORKDAY_CXS_COOLDOWN_MS,
 * then one probe is allowed through to re-test. Any alive/closed verdict
 * resets the breaker, so a tenant that re-enables the endpoint recovers on its
 * own.
 *
 * Per-process and in-memory on purpose: it is a cost/politeness optimization,
 * never an authorization or correctness boundary, and a restart simply re-
 * learns within one tick. Deliberately NOT a shared cross-tier file — unlike
 * the arXiv cooldown, being wrong here costs a handful of requests, not an IP
 * ban, and each process converges independently within a single tick.
 *
 * 2026-08-02 — WHAT COUNTS AS A REFUSAL TIGHTENED, the trip threshold did not.
 * The breaker was parking tenants it should never have touched: Blue Origin's
 * CXS endpoint answers 200 ten times out of ten sequentially, but its
 * occasional load-shaped 403 counted a full strike, and three of those parked
 * 1,621 postings for six hours (see SOFT_REFUSAL_STATUSES for the measurement).
 * `noteCxsRefusal` is now reached only after probeViaHttpStatus has spent its
 * retries, so a 403 that clears on attempt 2 or 3 reaches noteCxsSuccess
 * instead. WORKDAY_CXS_TRIP_AFTER stays at 3 deliberately: for a tenant that
 * really does refuse everything (Boeing, 6 of 6 at one request per second) the
 * breaker's value is unchanged, it just arrives a few requests later — and 3
 * lines up with SOFT_REFUSAL_ABORT_AFTER, so the tenant park and the batch
 * abort land on the same probe rather than one leaking past the other.
 */
interface CxsBreakerState { consecutiveRefusals: number; blockedUntil: number }
const WORKDAY_CXS_BREAKER = new Map<string, CxsBreakerState>();
const WORKDAY_CXS_TRIP_AFTER = 3;
const WORKDAY_CXS_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/** Test seam — the breaker is module state, so smokes must be able to clear it. */
export function _resetWorkdayCxsBreakerForTests(): void {
    WORKDAY_CXS_BREAKER.clear();
}

function cxsBreakerOpen(host: string): boolean {
    const s = WORKDAY_CXS_BREAKER.get(host);
    return s != null && s.blockedUntil > Date.now();
}

function noteCxsRefusal(host: string): void {
    const s = WORKDAY_CXS_BREAKER.get(host) ?? { consecutiveRefusals: 0, blockedUntil: 0 };
    s.consecutiveRefusals++;
    if (s.consecutiveRefusals >= WORKDAY_CXS_TRIP_AFTER) {
        s.blockedUntil = Date.now() + WORKDAY_CXS_COOLDOWN_MS;
        s.consecutiveRefusals = 0; // re-arm: the post-cooldown probe gets a clean count
        console.warn(
            `[liveness] workday CXS detail endpoint refusing for ${host} — skipping its probes for ` +
            `${Math.round(WORKDAY_CXS_COOLDOWN_MS / 60000)}m. Close-detection is paused for this tenant; ` +
            `its job-listing crawl is unaffected.`,
        );
    }
    WORKDAY_CXS_BREAKER.set(host, s);
}

function noteCxsSuccess(host: string): void {
    WORKDAY_CXS_BREAKER.delete(host);
}

async function probeWorkday(p: ProbeInput, ctx: ProbeContext): Promise<LivenessResult> {
    // C2 — prefer the structured CXS JSON endpoint over the HTML scrape.
    const cxsUrl = deriveWorkdayCxsUrl(p.sourceUrl);
    const cxsHost = cxsUrl ? hostOf(cxsUrl) : "";
    if (cxsUrl && cxsBreakerOpen(cxsHost)) {
        // Tenant's detail endpoint is known-refusing — no verdict is reachable
        // and the HTML fallback below can't help (see the note there), so spend
        // nothing at all this tick.
        return "unknown";
    }
    if (cxsUrl) {
        // Track refusal separately from the batch-level abort: a refusal means
        // "this host is saying no", which is also the signal to skip the HTML
        // fallback below rather than immediately hitting the SAME host again.
        //
        // This fires only once probeViaHttpStatus has spent its soft-refusal
        // retries, and only if the probe never reached alive/closed — which is
        // the whole point for Blue Origin: a 403 that clears on attempt 2
        // returns a verdict, so `refused` stays false, noteCxsRefusal is never
        // called, and noteCxsSuccess wipes the breaker's count instead of
        // advancing it toward the 6h park. The converse matters just as much:
        // a 403 followed by a TIMEOUT still latches, so the breaker and the
        // fallback-skip below both still engage — see the note on
        // probeViaHttpStatus for the regression where they did not.
        let refused = false;
        const noteRefusal = (status?: number) => { refused = true; ctx.onRateLimit?.(status); };
        const r = await probeViaHttpStatus(cxsUrl, { ...ctx, onRateLimit: noteRefusal }, LINKEDIN_UA, ({ bodyLower }) => {
            // 200 from CXS — read the tier-4 flags. `posted:false` (record
            // exists but the posting was taken down) is the unambiguous removal
            // signal → closed. Booleans are emitted minified; accept whitespace
            // variants. We deliberately do NOT close on `canApply:false` alone:
            // a live posting can disable apply (paused / region-gated) while
            // still being a real, viewable opening — closing on it would
            // re-introduce the false-close the gate exists to kill. Both
            // `posted:true` and `canApply:true` are positive alive evidence.
            if (/"posted"\s*:\s*false/.test(bodyLower)) return "closed";
            if (/"posted"\s*:\s*true/.test(bodyLower) || /"canapply"\s*:\s*true/.test(bodyLower)) return "alive";
            // 200 but no recognizable flag (shape drift) → don't conclude from
            // CXS; signal ambiguity and let the HTML fallback below try.
            return "unknown";
        });
        // 404/410 on CXS → posting removed (closed). 200 with a flag → trust it.
        // "unknown" → CXS was inconclusive (shape drift): fall back to the HTML
        // probe rather than concluding from a half-read payload.
        if (r === "closed" || r === "alive") { noteCxsSuccess(cxsHost); return r; }
        if (refused) {
            // The host just refused us. Immediately hitting the SAME host again
            // for the HTML fallback is precisely the hammering that got this
            // IP blocked, and that fallback cannot succeed anyway (below).
            noteCxsRefusal(cxsHost);
            return "unknown";
        }
    }
    // HTML fallback — reached only for a NON-canonical sourceUrl or genuine CXS
    // shape drift, never after a refusal.
    //
    // Caveat worth knowing before trusting this path: modern Workday tenants
    // serve the posting page as a client-rendered SPA. Boeing's is 6.5 KB whose
    // only structural hook is `id="root"` — none of WORKDAY_ALIVE_MARKERS and
    // none of WORKDAY_CLOSED_MARKERS can ever appear in it, so this probe
    // resolves "unknown" on those tenants no matter what. The markers below are
    // kept for server-rendered tenants (and are harmless), but do NOT assume
    // this fallback provides real coverage for the CXS-blocked ones.
    return probeViaHttpStatus(p.sourceUrl, ctx, LINKEDIN_UA /* Workday + Cloudflare hates non-browser UAs */, ({ finalUrl, bodyLower }) => {
        // OQ4b — redirected off the /job/ path (this includes Workday auth
        // gates, which used to be treated as closure evidence). Closed only
        // when we landed on the tenant's own board-root/search surface or a
        // body closed-marker hits; login / consent / challenge interstitials
        // → "unknown".
        if (!finalUrl.includes("/job/")) {
            return offPathRedirectVerdict(finalUrl, bodyLower, WORKDAY_CLOSED_MARKERS, isWorkdaySearchSurface);
        }
        for (const m of WORKDAY_CLOSED_MARKERS) {
            if (bodyLower.includes(m)) return "closed";
        }
        // C1 — require a live-posting marker before declaring alive, so a
        // Cloudflare interstitial / partial body that kept the /job/ URL
        // doesn't read as a live posting. Ambiguous 200 → "unknown".
        const hasAliveMarker = WORKDAY_ALIVE_MARKERS.some(m => bodyLower.includes(m));
        if (!hasAliveMarker) return "unknown";
        return null;
    });
}

/**
 * Status-only probe for the kinds whose "removed" state is a real 404/410.
 *
 * clearcompany used to be handled here and was the module's known blind spot:
 * its SPA host answers 200 with a byte-identical empty shell for every job
 * path, so this probe returned "alive" unconditionally (245 postings, 0 ever
 * closed). It moved to probeClearCompany on 2026-08-02 — a structured tier-4
 * probe of the public detail API. If you are tempted to add clearcompany body
 * markers here, read the note on probeClearCompany first: the shell contains
 * neither the job id nor the title, so no marker can discriminate.
 *
 * The kinds left on this probe (smartrecruiters, workable, recruitee, personio,
 * careers-page) have NOT been audited the way ashby / clearcompany were. If one
 * of them shows a suspiciously low close rate, suspect the same "200 for
 * everything" shape rather than assuming the postings are all still live.
 */
async function probeGeneric(p: ProbeInput, ctx: ProbeContext): Promise<LivenessResult> {
    return probeViaHttpStatus(p.sourceUrl, ctx, POLITE_UA);
}

type ProbeHandler = (p: ProbeInput, ctx: ProbeContext) => Promise<LivenessResult>;
const PROBE_HANDLERS: Record<WatchlistKind, ProbeHandler> = {
    linkedin:        probeLinkedin,
    indeed:          probeIndeed,
    workday:         probeWorkday,
    greenhouse:      probeGreenhouse,
    lever:           probeLever,
    ashby:           probeAshby,
    smartrecruiters: probeGeneric,
    workable:        probeGeneric,
    recruitee:       probeGeneric,
    personio:        probeGeneric,
    clearcompany:    probeClearCompany,
    "careers-page":  probeGeneric,
};

// ─── Public API ───────────────────────────────────────────────────────────

export async function probePostingLiveness(
    posting: ProbeInput,
    kind: WatchlistKind,
    /**
     * `takeRetry` / `minRetryDelayMs` are the batch-wide retry controls (see
     * ProbeContext). Omitting them — which every caller outside probeBatch does
     * — leaves retries unbudgeted and unfloored, bounded only per-probe by
     * SOFT_REFUSAL_MAX_RETRIES. That is correct for a one-off diagnostic probe;
     * it is NOT sufficient for a loop over hundreds of postings.
     */
    opts: {
        timeoutMs?: number;
        onRateLimit?: RateLimitCallback;
        takeRetry?: () => boolean;
        minRetryDelayMs?: number;
    } = {},
): Promise<LivenessResult> {
    const profile = PROBE_PROFILES[kind];
    const handler = PROBE_HANDLERS[kind];
    if (!profile || !handler) {
        console.warn(`[liveness] no profile for kind=${kind} — defaulting to unknown`);
        return "unknown";
    }
    const timeoutMs = opts.timeoutMs ?? profile.timeoutMs;
    try {
        const result = await handler(posting, {
            timeoutMs,
            onRateLimit: opts.onRateLimit,
            takeRetry: opts.takeRetry,
            minRetryDelayMs: opts.minRetryDelayMs,
        });
        console.info(`[liveness] kind=${kind} ${result} url=${posting.sourceUrl}`);
        return result;
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[liveness] kind=${kind} threw for ${posting.sourceUrl}: ${msg}`);
        return "unknown";
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Hermetic-test escape hatch. When `MC_LIVENESS_BYPASS` is set to one of the
 * three `LivenessResult` strings, `probeBatch` short-circuits — every input
 * gets that verdict, no network calls, no cap enforcement. Strictly for
 * smokes that need to assert on the close UPDATE path's behavior at scale
 * without paying for thousands of fixture-server probes.
 *
 *   Production MUST NOT set this. Doing so re-introduces the false-close
 *   behavior the probe gate exists to fix. P3.1c hard-enforces that: on a
 *   production tier (MC_SCHEDULER_TIER=prod or NODE_ENV=production) the
 *   bypass is IGNORED — one loud warn, then real probes — so a leaked env
 *   var can't mass-close prod rows. Hermetic smokes run with neither var
 *   set, so they keep working.
 */
let warnedProdBypassIgnored = false;
function bypassVerdict(): LivenessResult | null {
    const v = process.env.MC_LIVENESS_BYPASS;
    if (v !== "alive" && v !== "closed" && v !== "unknown") return null;
    if (process.env.MC_SCHEDULER_TIER === "prod" || process.env.NODE_ENV === "production") {
        if (!warnedProdBypassIgnored) {
            console.warn(
                `[liveness] MC_LIVENESS_BYPASS="${v}" is set on a production tier ` +
                `(MC_SCHEDULER_TIER=${process.env.MC_SCHEDULER_TIER ?? ""}, NODE_ENV=${process.env.NODE_ENV ?? ""}) — ` +
                `IGNORING it and probing for real. Unset this env var; it would re-introduce mass false-closes.`,
            );
            warnedProdBypassIgnored = true;
        }
        return null;
    }
    return v;
}

/**
 * Probes up to `profile.maxPerTick` postings for one kind. Postings past the
 * cap come back as "unknown" so callers leave them alone for the next tick.
 *
 * Concurrency model:
 *   - `perHitDelayMs > 0` (LinkedIn, Ashby, careers-page) → serial probes
 *     with sleep between consecutive starts. Same host can't be hit faster
 *     than `perHitDelayMs`.
 *   - otherwise (Greenhouse, Lever, Workday, generic APIs) → bounded-
 *     parallel via N=`concurrency` workers draining a shared cursor.
 *
 * Back-off model (revised 2026-08-02 — see SOFT_REFUSAL_STATUSES for the
 * measurement that forced it). An abort flag flips on; subsequent scheduled
 * probes short-circuit to "unknown" (no further fetches). Already-in-flight
 * probes complete and their results stand — the contract is "no MORE fetches
 * after abort", not "rewind what finished". What changed is WHEN the flag
 * flips:
 *   - HARD refusal (429 / 5xx, or an unattributed one) → immediately, exactly
 *     as before. These are self-describing: the source is telling us to stop.
 *   - SOFT refusal (403) → only after SOFT_REFUSAL_ABORT_AFTER probes IN A ROW
 *     have each refused through their retries. Any probe that reaches a real
 *     verdict resets the run.
 * The old rule — ONE 403 anywhere ends the tick — is what made a Blue Origin
 * tick read `candidates=922 alive=1 unknown=921`: one sporadic 403 discarded
 * ~59 of the 60 probes the profile allowed.
 *
 * Request volume is bounded on BOTH axes, which needs both mechanisms: the
 * consecutive-refusal abort bounds the DETERMINISTIC refuser, and the shared
 * SOFT_REFUSAL_RETRY_BUDGET bounds the SPORADIC one (which never triggers an
 * abort at all, and was therefore capped only by `maxPerTick × attempts` until
 * the budget landed). `maxPerTick` remains a cap on PROBES; the budget is what
 * keeps REQUESTS capped alongside it.
 */
export async function probeBatch(
    postings: ProbeInput[],
    kind: WatchlistKind,
    opts: { profile?: Partial<ProbeProfile> } = {},
): Promise<Map<string, LivenessResult>> {
    const bypass = bypassVerdict();
    if (bypass !== null) {
        const out = new Map<string, LivenessResult>();
        for (const p of postings) out.set(p.externalId, bypass);
        return out;
    }
    const base = PROBE_PROFILES[kind];
    if (!base) {
        const out = new Map<string, LivenessResult>();
        for (const p of postings) out.set(p.externalId, "unknown");
        return out;
    }
    const profile: ProbeProfile = { ...base, ...opts.profile };

    const out = new Map<string, LivenessResult>();
    const inScope = postings.slice(0, profile.maxPerTick);
    const overflow = postings.slice(profile.maxPerTick);
    for (const p of overflow) out.set(p.externalId, "unknown");

    if (inScope.length === 0) return out;

    // Shared abort flag — see the back-off model in this function's doc.
    let rateLimitedAborted = false;
    /** Probes that refused with no DEFINITIVE verdict in between — see SOFT_REFUSAL_ABORT_AFTER. */
    let softRefusalsInARow = 0;
    /**
     * Extra attempts still available to the WHOLE batch. This, not the
     * per-probe retry cap, is what makes the request count bounded for a
     * partially-refusing tenant — see SOFT_REFUSAL_RETRY_BUDGET.
     */
    let retryBudget = SOFT_REFUSAL_RETRY_BUDGET(profile.maxPerTick);
    let warnedBudgetExhausted = false;
    const takeRetry = (): boolean => {
        if (retryBudget <= 0) {
            if (!warnedBudgetExhausted) {
                console.warn(
                    `[liveness] kind=${kind} exhausted its per-batch retry budget ` +
                    `(${SOFT_REFUSAL_RETRY_BUDGET(profile.maxPerTick)} extra attempts) — remaining probes get one ` +
                    `attempt each. A tenant refusing this often should be tripping the consecutive-refusal abort.`,
                );
                warnedBudgetExhausted = true;
            }
            return false;
        }
        retryBudget--;
        return true;
    };

    function abortRemaining(reason: string): void {
        if (rateLimitedAborted) return;
        // `out` was pre-seeded with the overflow verdicts above, so
        // `inScope.length - out.size` under-counts by exactly the overflow
        // and went NEGATIVE on big backlogs ("aborting remaining -2542
        // probes"). Subtract only the in-scope results resolved so far.
        const resolvedInScope = out.size - overflow.length;
        console.warn(`[liveness] kind=${kind} ${reason} — aborting remaining ${inScope.length - resolvedInScope} probes for this batch`);
        rateLimitedAborted = true;
    }

    /**
     * Run ONE probe with its OWN refusal sink, then fold the outcome into the
     * batch counters.
     *
     * The sink has to be per-probe, not a single shared callback: in parallel
     * mode several probes are in flight at once, so a shared `refused` flag
     * would attribute one probe's 403 to whichever probe happened to finish
     * next, and "consecutive" would stop meaning anything.
     */
    async function runProbe(p: ProbeInput): Promise<LivenessResult> {
        let softRefusal = false;
        let hardRefusal: number | null = null;
        const verdict = await probePostingLiveness(p, kind, {
            timeoutMs: profile.timeoutMs,
            takeRetry,
            // A retry must not outrun the same-host pacing this batch promises.
            minRetryDelayMs: profile.perHitDelayMs,
            // LATCHES, not counters: a handler that probes two endpoints
            // (greenhouse / lever) can fire this twice for one posting — see
            // the firing contract on RateLimitCallback. A missing status is
            // treated as HARD, so an unattributed refusal takes the
            // conservative branch.
            onRateLimit: (status?: number) => {
                if (status !== undefined && SOFT_REFUSAL_STATUSES(status)) softRefusal = true;
                else hardRefusal = status ?? 0;
            },
        });
        // Order matters, and this order is a fix (2026-08-02). The refusal
        // branch used to come first, which made "counted as a refusal" and
        // "cleared the run" mutually exclusive — so a greenhouse or lever probe
        // whose API endpoint 403s but whose HTML fallback answers reached a
        // GENUINE `alive` and still advanced the run. Measured: 20 greenhouse
        // postings, API 403 + HTML fine → 10 real verdicts and the batch aborted
        // anyway, which would silently cap the fleet's largest kind at ~10
        // postings per tick. That is the same self-inflicted blackout this whole
        // change exists to remove, just relocated.
        //
        // The HARD branch deliberately stays ABOVE the verdict check, which is
        // the one place this deviates from the reviewer's suggested ordering: a
        // 429/5xx is a politeness OBLIGATION, not evidence, and reaching a
        // verdict via some other endpoint does not discharge it. Concretely, if
        // boards-api.greenhouse.io 429s on every probe while the HTML page
        // answers, "verdict wins" would keep hitting the rate-limited API 200
        // more times in the same tick. Soft refusals — the measured regression
        // — are fully covered by the reorder below them.
        if (hardRefusal !== null) {
            abortRemaining(`refused (${hardRefusal || "429/5xx"})`);
        } else if (verdict !== "unknown") {
            // Definitive evidence: the source IS answering us, so the run of
            // refusals is broken even if some endpoint refused along the way.
            softRefusalsInARow = 0;
        } else if (softRefusal) {
            softRefusalsInARow++;
            if (softRefusalsInARow >= SOFT_REFUSAL_ABORT_AFTER) {
                abortRemaining(`refused 403 on ${softRefusalsInARow} probes with no verdict in between (deterministic, not sporadic)`);
            }
        }
        // Remaining case — "unknown" with no refusal seen at all (plain
        // timeout, ambiguous 200, SSRF-guard trip) — is deliberately NEUTRAL:
        // it neither counts nor clears. See SOFT_REFUSAL_ABORT_AFTER.
        return verdict;
    }

    if (profile.perHitDelayMs > 0) {
        // Serial probes with delay — LinkedIn / ashby / careers-page mode.
        for (let i = 0; i < inScope.length; i++) {
            if (rateLimitedAborted) {
                for (let j = i; j < inScope.length; j++) out.set(inScope[j].externalId, "unknown");
                return out;
            }
            const p = inScope[i];
            out.set(p.externalId, await runProbe(p));
            // Skip the trailing sleep — nothing more to pace.
            if (i < inScope.length - 1) await sleep(profile.perHitDelayMs);
        }
        return out;
    }

    // Bounded-parallel mode (Greenhouse / Lever / Workday / generic APIs).
    let cursor = 0;
    async function worker() {
        for (;;) {
            const i = cursor++;
            if (i >= inScope.length) return;
            const p = inScope[i];
            if (rateLimitedAborted) {
                out.set(p.externalId, "unknown");
                continue;
            }
            out.set(p.externalId, await runProbe(p));
        }
    }
    const workers = Array.from({ length: Math.min(profile.concurrency, inScope.length) }, () => worker());
    await Promise.all(workers);
    return out;
}
