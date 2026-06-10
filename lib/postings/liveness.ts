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
import { loggedFetch } from "@/lib/external-fetch";
import { assertExternalHttpUrl, assertSafeResponseUrl, UnsafeURLError } from "@/lib/security/url-guard";
import type { WATCHLIST_KINDS } from "@/lib/schemas/watchlists";

/**
 * Optional callback fired when a probe sees HTTP 429. `probeBatch` wires this
 * to a shared abort flag so subsequent probes in the batch short-circuit
 * instead of hammering a host that's already telegraphing back-off.
 */
type RateLimitCallback = () => void;

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
    workday:         { concurrency: 6, perHitDelayMs:    0, maxPerTick: 500, timeoutMs: 5000 },
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
        let res: Response;
        try {
            res = await loggedFetch(url, {
                method: "GET",
                redirect: "follow",
                signal,
                headers: {
                    "User-Agent": userAgent,
                    "Accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.5",
                    "Accept-Language": "en-US,en;q=0.9",
                },
            });
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.warn(`[liveness] fetch threw for ${url}: ${msg}`);
            return "unknown" as LivenessResult;
        }
        // Re-validate post-redirect URL — if a source 302'd us to an internal
        // host (compromised / misconfigured), refuse to draw a conclusion.
        try {
            assertSafeResponseUrl(res);
        } catch (e) {
            if (e instanceof UnsafeURLError) {
                console.warn(`[liveness] unsafe redirect target from ${url}: ${e.message}`);
                return "unknown" as LivenessResult;
            }
            throw e;
        }
        if (res.status === 429) {
            // Source asking us to back off — telegraph upward so the batch
            // can abort subsequent probes instead of hammering harder.
            onRateLimit?.();
            return "rate-limited" as const;
        }
        if (res.status === 404 || res.status === 410) return "closed" as LivenessResult;
        if (res.status >= 500) return "unknown" as LivenessResult;
        if (!res.ok) return "unknown" as LivenessResult;

        // 2xx — let the optional extra check inspect body / final URL.
        if (extraClosedCheck) {
            const text = await res.text().catch(() => "");
            const finalUrl = res.url || url;
            const verdict = extraClosedCheck({ finalUrl, bodyLower: text.toLowerCase() });
            if (verdict) return verdict;
        }
        return "alive" as LivenessResult;
    });
    if (result === "timeout") return "unknown";
    if (result === "rate-limited") return "unknown";
    return result;
}

// ─── Per-kind probes ──────────────────────────────────────────────────────

async function probeLinkedin(p: ProbeInput, timeoutMs: number, onRateLimit?: RateLimitCallback): Promise<LivenessResult> {
    return probeViaHttpStatus(p.sourceUrl, timeoutMs, LINKEDIN_UA, ({ finalUrl, bodyLower }) => {
        if (!finalUrl.includes("/jobs/view/")) return "closed";
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
        // Off /viewjob entirely → Indeed redirected us to search or homepage.
        if (!finalUrl.includes("/viewjob")) return "closed";
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

async function probeWorkday(p: ProbeInput, timeoutMs: number, onRateLimit?: RateLimitCallback): Promise<LivenessResult> {
    // C2 — prefer the structured CXS JSON endpoint over the HTML scrape.
    const cxsUrl = deriveWorkdayCxsUrl(p.sourceUrl);
    if (cxsUrl) {
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
        }, onRateLimit);
        // 404/410 on CXS → posting removed (closed). 200 with a flag → trust it.
        // "unknown" → CXS was inconclusive (shape drift / blocked): fall back
        // to the HTML probe rather than concluding from a half-read payload.
        if (r === "closed" || r === "alive") return r;
    }
    // HTML fallback (CXS unavailable / inconclusive / non-canonical URL).
    return probeViaHttpStatus(p.sourceUrl, timeoutMs, LINKEDIN_UA /* Workday + Cloudflare hates non-browser UAs */, ({ finalUrl, bodyLower }) => {
        // Redirected to a Workday auth gate → posting is no longer publicly listed.
        if (/\/(login|portal\/login)\b/i.test(finalUrl)) return "closed";
        // Redirected off /job/ path entirely (search page / home / 404 stub) → closed.
        if (!finalUrl.includes("/job/")) return "closed";
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
 *   behavior the probe gate exists to fix.
 */
function bypassVerdict(): LivenessResult | null {
    const v = process.env.MC_LIVENESS_BYPASS;
    if (v === "alive" || v === "closed" || v === "unknown") return v;
    return null;
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
            console.warn(`[liveness] kind=${kind} got HTTP 429 — aborting remaining ${inScope.length - out.size} probes for this batch`);
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
