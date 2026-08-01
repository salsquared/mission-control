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
 * 403, or 5xx (see BACKOFF_STATUSES). `probeBatch` wires this to a shared abort
 * flag so subsequent probes in the batch short-circuit instead of hammering a
 * host that's already telegraphing back-off.
 *
 * Named for the 429 case it originally handled; kept as-is because external
 * callers (scripts/tests/debug/recover-false-closed.ts, the close-detection
 * audit probe) pass `onRateLimit` by name.
 */
type RateLimitCallback = () => void;

/**
 * Statuses treated as "the source is refusing us", not as evidence about the
 * posting. All three abort the rest of the batch.
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

export type WatchlistKind = (typeof WATCHLIST_KINDS)[number];
export type LivenessResult = "alive" | "closed" | "unknown";

export interface ProbeInput {
    /** Map key for batch results. Same value as `JobPosting.externalId`. */
    externalId: string;
    sourceUrl: string;
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
    clearcompany:    { concurrency: 4, perHitDelayMs:    0, maxPerTick: 100, timeoutMs: 5000 },
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
const ASHBY_ALIVE_MARKERS = [
    "window.__appdata", // the embedded SPA state blob (lowercased)
    "\"islisted\":true",
    "ashby_jb_posting", // posting widget container id seen on live pages
    "application-form",
];
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
 */
async function probeViaHttpStatus(
    url: string,
    timeoutMs: number,
    userAgent: string,
    extraClosedCheck?: (final: { finalUrl: string; bodyLower: string }) => LivenessResult | null,
    onRateLimit?: RateLimitCallback,
): Promise<LivenessResult> {
    try {
        assertExternalHttpUrl(url);
    } catch (e) {
        if (e instanceof UnsafeURLError) return "unknown";
        throw e;
    }
    const result = await withTimeout(timeoutMs, async (signal) => {
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
                return "unknown" as LivenessResult;
            }
            throw e;
        }
        if (BACKOFF_STATUSES(res.status)) {
            // Source refusing us (429 / 403 / 5xx) — telegraph upward so the
            // batch aborts subsequent probes instead of hammering harder.
            // Never closure evidence: see the note on BACKOFF_STATUSES.
            onRateLimit?.();
            return "rate-limited" as const;
        }
        if (res.status === 404 || res.status === 410) return "closed" as LivenessResult;
        if (!res.ok) return "unknown" as LivenessResult;

        // 2xx — let the optional extra check inspect body / final URL.
        if (extraClosedCheck) {
            const text = await res.text().catch(() => "");
            const finalUrl = res.url || requestedUrl;
            const verdict = extraClosedCheck({ finalUrl, bodyLower: text.toLowerCase() });
            if (verdict) return verdict;
        }
        return "alive" as LivenessResult;
    });
    const verdict: LivenessResult = result === "timeout" || result === "rate-limited" ? "unknown" : result;
    recordProbeOutcome(url, verdict);
    return verdict;
}

/**
 * Fetcher-health attribution for ONE probe attempt.
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

async function probeLinkedin(p: ProbeInput, timeoutMs: number, onRateLimit?: RateLimitCallback): Promise<LivenessResult> {
    return probeViaHttpStatus(p.sourceUrl, timeoutMs, LINKEDIN_UA, ({ finalUrl, bodyLower }) => {
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
    }, onRateLimit);
}

async function probeIndeed(p: ProbeInput, timeoutMs: number, onRateLimit?: RateLimitCallback): Promise<LivenessResult> {
    // Indeed UA-sniffs the same way LinkedIn / Workday do — Cloudflare flags
    // anything that doesn't look like a real browser.
    return probeViaHttpStatus(p.sourceUrl, timeoutMs, LINKEDIN_UA, ({ finalUrl, bodyLower }) => {
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
    }, onRateLimit);
}

const GREENHOUSE_URL_RE = /^https?:\/\/[^/]+greenhouse\.io\/([^/]+)\/jobs\/(\d+)/i;
async function probeGreenhouse(p: ProbeInput, timeoutMs: number, onRateLimit?: RateLimitCallback): Promise<LivenessResult> {
    const m = p.sourceUrl.match(GREENHOUSE_URL_RE);
    if (m) {
        const slug = m[1];
        const jobId = m[2];
        const apiUrl = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs/${encodeURIComponent(jobId)}`;
        const r = await probeViaHttpStatus(apiUrl, timeoutMs, POLITE_UA, undefined, onRateLimit);
        if (r !== "unknown") return r;
    }
    // Fall back to probing the canonical HTML page.
    return probeViaHttpStatus(p.sourceUrl, timeoutMs, POLITE_UA, undefined, onRateLimit);
}

const LEVER_URL_RE = /^https?:\/\/jobs\.lever\.co\/([^/]+)\/([0-9a-f-]{16,})/i;
async function probeLever(p: ProbeInput, timeoutMs: number, onRateLimit?: RateLimitCallback): Promise<LivenessResult> {
    const m = p.sourceUrl.match(LEVER_URL_RE);
    if (m) {
        const slug = m[1];
        const postingId = m[2];
        const apiUrl = `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}/${encodeURIComponent(postingId)}`;
        const r = await probeViaHttpStatus(apiUrl, timeoutMs, POLITE_UA, undefined, onRateLimit);
        if (r !== "unknown") return r;
    }
    return probeViaHttpStatus(p.sourceUrl, timeoutMs, POLITE_UA, undefined, onRateLimit);
}

async function probeAshby(p: ProbeInput, timeoutMs: number, onRateLimit?: RateLimitCallback): Promise<LivenessResult> {
    return probeViaHttpStatus(p.sourceUrl, timeoutMs, POLITE_UA, ({ finalUrl, bodyLower }) => {
        // Redirected to the bare board root (no posting-id segment) → closed.
        // Posting URLs are jobs.ashbyhq.com/<slug>/<uuid>; board-root is /<slug>.
        try {
            const u = new URL(finalUrl);
            const segments = u.pathname.split("/").filter(Boolean);
            if (u.host.includes("ashbyhq.com") && segments.length < 2) return "closed";
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
    }, onRateLimit);
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

async function probeWorkday(p: ProbeInput, timeoutMs: number, onRateLimit?: RateLimitCallback): Promise<LivenessResult> {
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
        let refused = false;
        const noteRefusal = () => { refused = true; onRateLimit?.(); };
        const r = await probeViaHttpStatus(cxsUrl, timeoutMs, LINKEDIN_UA, ({ bodyLower }) => {
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
        }, noteRefusal);
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
    return probeViaHttpStatus(p.sourceUrl, timeoutMs, LINKEDIN_UA /* Workday + Cloudflare hates non-browser UAs */, ({ finalUrl, bodyLower }) => {
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
    }, onRateLimit);
}

async function probeGeneric(p: ProbeInput, timeoutMs: number, onRateLimit?: RateLimitCallback): Promise<LivenessResult> {
    return probeViaHttpStatus(p.sourceUrl, timeoutMs, POLITE_UA, undefined, onRateLimit);
}

type ProbeHandler = (p: ProbeInput, timeoutMs: number, onRateLimit?: RateLimitCallback) => Promise<LivenessResult>;
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
    clearcompany:    probeGeneric,
    "careers-page":  probeGeneric,
};

// ─── Public API ───────────────────────────────────────────────────────────

export async function probePostingLiveness(
    posting: ProbeInput,
    kind: WatchlistKind,
    opts: { timeoutMs?: number; onRateLimit?: RateLimitCallback } = {},
): Promise<LivenessResult> {
    const profile = PROBE_PROFILES[kind];
    const handler = PROBE_HANDLERS[kind];
    if (!profile || !handler) {
        console.warn(`[liveness] no profile for kind=${kind} — defaulting to unknown`);
        return "unknown";
    }
    const timeoutMs = opts.timeoutMs ?? profile.timeoutMs;
    try {
        const result = await handler(posting, timeoutMs, opts.onRateLimit);
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
 * On the first HTTP 429 in the batch, an abort flag flips on; subsequent
 * scheduled probes short-circuit to "unknown" (no further fetches). The
 * already-in-flight probes complete (their results stand). This is how the
 * batch respects a "source asked us to back off" signal without trying to
 * cancel inflight TCP connections.
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

    // Shared abort flag — set on first 429 anywhere in the batch.
    let rateLimitedAborted = false;
    const onRateLimit = () => {
        if (!rateLimitedAborted) {
            // `out` was pre-seeded with the overflow verdicts above, so
            // `inScope.length - out.size` under-counts by exactly the overflow
            // and went NEGATIVE on big backlogs ("aborting remaining -2542
            // probes"). Subtract only the in-scope results resolved so far.
            const resolvedInScope = out.size - overflow.length;
            console.warn(`[liveness] kind=${kind} refused (429/403/5xx) — aborting remaining ${inScope.length - resolvedInScope} probes for this batch`);
            rateLimitedAborted = true;
        }
    };
    const probeOpts = { timeoutMs: profile.timeoutMs, onRateLimit };

    if (profile.perHitDelayMs > 0) {
        // Serial probes with delay — LinkedIn / ashby / careers-page mode.
        for (let i = 0; i < inScope.length; i++) {
            if (rateLimitedAborted) {
                for (let j = i; j < inScope.length; j++) out.set(inScope[j].externalId, "unknown");
                return out;
            }
            const p = inScope[i];
            out.set(p.externalId, await probePostingLiveness(p, kind, probeOpts));
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
            out.set(p.externalId, await probePostingLiveness(p, kind, probeOpts));
        }
    }
    const workers = Array.from({ length: Math.min(profile.concurrency, inScope.length) }, () => worker());
    await Promise.all(workers);
    return out;
}
