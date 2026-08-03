/**
 * ClearCompany public job-board fetcher.
 *
 * https://careers-api.clearcompany.com/v1/<siteId> — siteId is a UUID
 * (e.g. 00ed92c3-5bfb-7bfb-456d-4d9d77fef9a5 for Firefly Aerospace), extractable
 * from the embedded
 *   <script src="https://careers-content.clearcompany.com/js/v1/career-site.js?siteId=<uuid>">
 * tag on a ClearCompany-backed careers page. No auth.
 *
 * ═══ ALWAYS PAGINATED. Do NOT "optimize" this back to one unpaginated call. ═══
 *
 * The original version issued a single parameterless GET and only paginated as
 * a fallback when the response came back short. That was written against a
 * 135-job board. Firefly's board is 181 today, and the unpaginated response is
 * 1,351,175 bytes — large enough that it does not reliably complete. When it
 * truncates, `await res.json()` throws, and the crawl aborted whole: not one
 * posting's `lastSeenAt` was refreshed that tick. This was live in prod, not
 * theoretical — `Watchlist.lastError` in prisma/prod.db read
 * `Fetch failed: terminated` (undici's error for a connection closed
 * mid-body).
 *
 * Measured live 2026-08-02, so nobody has to re-derive it:
 *
 *   | Transport                     | Attempts | Completed | Failure                     |
 *   |-------------------------------|----------|-----------|-----------------------------|
 *   | HTTP/2                        |    3     |     0     | curl 92 framing-layer stream|
 *   |                               |          |           | error; truncated at 395 KB /|
 *   |                               |          |           | 498 KB / 804 KB             |
 *   | HTTP/1.1 (what undici uses)   |    3     |     2     | curl 18 partial file, 613 KB|
 *   | ?pageIndex=N&pageSize=50      |    8     |     8     | none                        |
 *
 * So forcing HTTP/1.1 is NOT the fix — Node's fetch is already on it, and it
 * still failed 1-in-3. Pagination is the fix: 4 pages of ~380 KB each, and
 * 50 + 50 + 50 + 31 = 181 = totalCount exactly. `pageIndex` is 0-based and the
 * pages did not overlap. PAGE_SIZE 50 is the measured-good size; a larger page
 * walks back toward the megabyte regime that truncates.
 *
 * Errors are returned, not thrown.
 */
import { z } from "zod";
import type { ClearCompanyConfigSchema } from "@/lib/schemas/watchlists";
import type { RawPosting, FetcherResult } from "./careers-page-fetcher";
import { pickEmploymentType } from "./employment-type";
import { loggedFetch, hostOf } from "@/lib/external-fetch";
import { recordFetchOutcome } from "@/lib/fetcher-health/store";

type ClearCompanyConfig = z.infer<typeof ClearCompanyConfigSchema>;

const CCLocationSchema = z.object({
    city: z.string().nullable().optional(),
    subdivision: z.string().nullable().optional(),
    subdivisionFullName: z.string().nullable().optional(),
    country: z.string().nullable().optional(),
    isRemote: z.boolean().nullable().optional(),
}).passthrough();

const CCPostingSchema = z.object({
    id: z.string(),
    positionTitle: z.string(),
    departmentName: z.string().nullable().optional(),
    officeName: z.string().nullable().optional(),
    location: z.string().nullable().optional(),
    locations: z.array(CCLocationSchema).nullable().optional(),
    applyLink: z.string().nullable().optional(),
    postedDate: z.string().nullable().optional(),
}).passthrough();

const CCResponseSchema = z.object({
    results: z.array(CCPostingSchema),
    totalCount: z.number(),
    currentPageIndex: z.number(),
    currentPageCount: z.number(),
});

const FETCH_TIMEOUT_MS = 8_000;
const PAGE_SIZE = 50; // measured-good page size (see the header table)
/**
 * 1,000-posting safety cap (20 x PAGE_SIZE). Firefly is 181, so ~5.5x headroom.
 *
 * NOTE this is a HARD ceiling in a way the old code was not: page 0 used to be
 * the unpaginated whole board, so a big tenant was fetched (badly) in full.
 * Now a board past 1,000 is truncated and flagged `partial: true`, which is the
 * right conservative behaviour — close-detection skips it rather than
 * false-closing the tail. But it must not become a SILENT ceiling if another
 * ClearCompany tenant is onboarded: the post-loop console.warn names the cap
 * and the posting count explicitly. If that warn ever shows up in the log
 * viewer, raise MAX_PAGES.
 */
const MAX_PAGES = 20;
/**
 * Politeness. `probeClearCompany` (lib/postings/liveness.ts) hits the SAME
 * host, careers-api.clearcompany.com, and its PROBE_PROFILES row runs SERIAL at
 * perHitDelayMs 250 for exactly that reason. Paginating turns one crawl request
 * into ~4, so pace them at the same 250ms rather than bursting into a budget
 * we share with close-detection.
 */
const PAGE_DELAY_MS = 250;
/** Backoff before the single bounded retry of a network-failed page. */
const RETRY_DELAY_MS = 500;

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export async function fetchClearCompany(config: ClearCompanyConfig): Promise<FetcherResult> {
    const base = `https://careers-api.clearcompany.com/v1/${encodeURIComponent(config.boardSlug)}`;

    const all: z.infer<typeof CCPostingSchema>[] = [];
    const seen = new Set<string>();
    /**
     * Did we stop because the board ran out (complete view) or because
     * something cut us short (incomplete view)? Only a drained board makes
     * absence-from-fetch trustworthy closure evidence — see the `partial` flag
     * on FetcherResult and job-watcher's SAFETY 2. Same contract as
     * workday-fetcher's `drained`.
     */
    let drained = false;
    /** pageIndex at which the server started repeating itself, if it did. */
    let repeatedPage: number | null = null;
    /**
     * High-water mark of every `totalCount` seen this crawl, NOT the current
     * page's value. ClearCompany reports the count on every page, and a single
     * page reporting a stale/low count would otherwise short-circuit the
     * `all.length >= totalCount` check and claim a complete crawl. Monotonic —
     * a board that legitimately SHRINKS mid-crawl still terminates, via the
     * empty-page path below rather than the count check.
     */
    let expectedTotal = 0;

    // ONE loop, starting at pageIndex=0. There is deliberately no separate
    // "first" call outside it: the previous shape did the one-shot fetch and
    // `return`ed on failure, so the paginated fallback below it was unreachable
    // in precisely the case that needed it — a truncated FIRST response never
    // got to try pagination. Every page, including page 0, now goes through
    // identical retry + failure handling.
    for (let page = 0; page < MAX_PAGES; page++) {
        if (page > 0) await sleep(PAGE_DELAY_MS);
        const url = `${base}?pageIndex=${page}&pageSize=${PAGE_SIZE}`;

        let res = await fetchPageWithRetry(url, `${config.companyName} pageIndex=${page}`);
        if (!res.ok) {
            // ABORT THE WHOLE CRAWL — do not return the pages collected so far.
            //
            // The obvious alternative is `{ ok: true, postings, partial: true }`
            // (what workday/linkedin/indeed do on a mid-crawl break). It is
            // rejected HERE, deliberately. `partial` does protect against the
            // false-close risk — job-watcher.ts:627 gates close-detection on
            // `!fetchResult.partial`, so stale rows would not be mass-closed.
            // The problem is the OTHER half of a partial success:
            // job-watcher.ts:961 writes `lastError: null` and bumps
            // `lastSuccessAt`. A truncating board would therefore be recorded
            // as a HEALTHY watchlist while silently under-reporting its board,
            // which is exactly how the 1.35 MB one-shot went unnoticed until
            // the stored `lastError` was read by hand. `ok: false` keeps the
            // failure durable and visible on the watchlist row; the single
            // retry above is what makes throwing away the tick affordable.
            // (Costs: no `lastSeenAt` refresh this tick. That is safe — a
            // failed fetch also skips close-detection entirely, and the next
            // successful tick re-sees everything.)
            return { ok: false, error: `ClearCompany fetch failed at pageIndex=${page}: ${res.error}` };
        }
        expectedTotal = Math.max(expectedTotal, res.data.totalCount);

        // An empty page BEFORE we've reached expectedTotal is the one remaining
        // way this fetcher could claim a COMPLETE crawl while missing rows: a
        // valid-JSON `results: []` from a cache/backend hiccup mid-board would
        // otherwise set drained=true, partial=false, and close-detection would
        // then run against a 50-of-181 view. job-watcher's SAFETY 1 does NOT
        // catch that — it gates on `fetchResult.postings.length > 0`, which a
        // 50-of-181 crawl passes. So confirm it with one more request through
        // the same retry helper before believing it. An over-reported
        // totalCount (the benign case) simply costs one extra request and then
        // drains; a transient empty page recovers its rows and the crawl
        // continues. Residual: a hiccup that persists across BOTH requests is
        // still believed — two independent empty responses is the strongest
        // evidence available here, and refusing to ever believe an empty page
        // would mean a board whose totalCount is inflated never drains.
        if (res.data.results.length === 0 && all.length < expectedTotal) {
            console.warn(`[clearcompany] ${config.companyName} pageIndex=${page}: empty page at ${all.length}/${expectedTotal} — confirming before treating the board as drained`);
            await sleep(RETRY_DELAY_MS);
            const confirm = await fetchPageWithRetry(url, `${config.companyName} pageIndex=${page} (empty-page confirm)`);
            if (!confirm.ok) {
                // Two stacked anomalies (unexplained empty page, then a failed
                // confirmation). We cannot tell drained from truncated, so take
                // the same visible-failure path as any other page failure
                // rather than guessing.
                return { ok: false, error: `ClearCompany fetch failed confirming empty pageIndex=${page}: ${confirm.error}` };
            }
            expectedTotal = Math.max(expectedTotal, confirm.data.totalCount);
            res = confirm;
        }

        const rows = res.data.results;
        let added = 0;
        for (const p of rows) {
            if (seen.has(p.id)) continue;
            seen.add(p.id);
            all.push(p);
            added++;
        }

        // Termination, in priority order.
        // 1. The board's own count, as a high-water mark. Also covers the empty
        //    board (0 >= 0), which is why that case costs only one request.
        if (all.length >= expectedTotal) { drained = true; break; }
        // 2. Server has nothing more to give, CONFIRMED by the check above.
        //    Reached when totalCount is over-reported. This is also why there
        //    is deliberately NO "short page => drained" rule: a short page that
        //    does NOT reach totalCount is ambiguous (flaky short page vs. end
        //    of board), and guessing "end of board" there would drop the rest
        //    of a large board while claiming a complete view.
        if (rows.length === 0) { drained = true; break; }
        // 3. A non-empty page that contributed no new ids means the server is
        //    repeating a page rather than advancing. Stop — but NOT drained, we
        //    have no idea what we missed. Also bounds the request count against
        //    a server stuck on one pageIndex.
        if (added === 0) { repeatedPage = page; break; }
    }

    // Anything other than a drained board is an incomplete view: the un-fetched
    // tail is unknown territory, so absence-from-fetch is NOT closure evidence.
    // Same lesson as workday-fetcher's cap handling — without this a board past
    // the cap looked like a COMPLETE crawl and every posting beyond it became a
    // false-close candidate.
    const partial = !drained;
    if (partial) {
        const reason = repeatedPage !== null
            ? `server repeated pageIndex=${repeatedPage} (0 new ids)`
            : `hit the ${MAX_PAGES}-page cap (${MAX_PAGES * PAGE_SIZE} postings)`;
        console.warn(`[clearcompany] ${config.companyName}: incomplete crawl — ${reason}; ${all.length} postings collected, flagging partial so close-detection skips this run`);
    }

    const postings: RawPosting[] = all
        .filter(p => p.positionTitle && p.applyLink)
        .map(p => {
            const locParts = [p.location, p.officeName].filter(s => s && s.trim());
            // Prefer the structured `locations[0]` shape when the flat string
            // is empty — happens occasionally.
            const struct = p.locations?.[0];
            const composedFromStruct = struct
                ? [struct.city, struct.subdivision ?? struct.subdivisionFullName, struct.country]
                    .filter(s => s && s.trim()).join(", ")
                : null;
            const location = locParts[0] ?? composedFromStruct ?? null;
            const remoteTag = struct?.isRemote ? "Remote" : null;
            const snippet = [p.departmentName, remoteTag].filter(Boolean).join(" · ") || null;
            return {
                company: config.companyName,
                title: p.positionTitle,
                sourceUrl: p.applyLink as string,
                location: location,
                snippet,
                // No structured employment-type field in the response — fall
                // back to title heuristics via pickEmploymentType's second arg.
                employmentType: pickEmploymentType(null, p.positionTitle),
            };
        });

    return partial ? { ok: true, postings, partial: true } : { ok: true, postings };
}

/**
 * Failure classes, so the retry decision is explicit rather than a string match
 * on the message:
 *   network — transport failure, aborted request, truncated body, or a body
 *             that didn't parse as JSON. Transient; retryable.
 *   http    — a non-2xx response. The server answered; retrying won't change it.
 *   shape   — 200 with a payload that doesn't match CCResponseSchema.
 *             Deterministic; retrying re-parses the same bad payload.
 *
 * Known ambiguity, accepted: a 200 carrying a well-formed NON-JSON body (a CDN
 * / WAF HTML interstitial) fails at res.json() and so classifies as `network`,
 * not `shape`. It therefore earns one wasted retry and records an `error`
 * health row where `broken` would be more accurate. Distinguishing "truncated
 * JSON" from "HTML that was never JSON" means sniffing the body, and the
 * mis-classification is bounded at one extra request — not worth the code.
 */
type PageFailureKind = "network" | "http" | "shape";

/**
 * `fetchPage` plus ONE bounded retry, and only for `network` (transport /
 * body-read / JSON-parse) failures — the class the truncation bug lives in.
 * Defence-in-depth, not the main fix: at PAGE_SIZE 50 the pages are ~380 KB and
 * completed 8/8 in measurement, so this should essentially never fire. A
 * `shape` failure is deterministic (retrying re-parses the same bad payload)
 * and an `http` failure is the server saying no, so neither is retried.
 * Bounded at one so a hard-down upstream costs 2 requests per page, not 2^n.
 *
 * Shared by the page walk and the empty-page confirmation so both get identical
 * failure handling — the single most important structural property of this
 * file is that no request path is special-cased (that is what made the old
 * one-shot's fallback unreachable).
 */
async function fetchPageWithRetry(url: string, label: string): Promise<PageResult> {
    const res = await fetchPage(url);
    if (res.ok || res.kind !== "network") return res;
    console.warn(`[clearcompany] ${label}: ${res.error} — retrying once`);
    await sleep(RETRY_DELAY_MS);
    return fetchPage(url);
}

type PageResult =
    | { ok: true; data: z.infer<typeof CCResponseSchema> }
    | { ok: false; error: string; kind: PageFailureKind };

async function fetchPage(url: string): Promise<PageResult> {
    let json: unknown;
    try {
        // record: false — defer to the parse-aware outcome below so one page
        // fetch = one health row (200-with-bad-shape is `broken`, not `ok`).
        // A retried page is a second fetch and so records a second row, which
        // is the honest count of attempts made against the host.
        //
        // AbortSignal.timeout, not a manual controller + clearTimeout: the old
        // shape cleared the timer as soon as `loggedFetch` resolved (i.e. at
        // HEADERS) and so left `await res.json()` — the body read — completely
        // untimed. The body read is precisely where this endpoint fails; a
        // stalled 1.35 MB stream could hang far past FETCH_TIMEOUT_MS. The
        // signal stays armed through the body read, so a page that stops
        // streaming now aborts at 8s and surfaces as a retryable `network`
        // failure instead of hanging. 8s is comfortable for a ~380 KB page.
        const res = await loggedFetch(url, {
            headers: {
                "User-Agent": "mission-control-watcher/1.0 (+https://mc.local; personal job-search agent)",
                "Accept": "application/json",
            },
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        }, { record: false });
        if (!res.ok) {
            recordFetchOutcome(hostOf(url), "error");
            return { ok: false, kind: "http", error: `HTTP ${res.status} ${res.statusText} from ${url}` };
        }
        json = await res.json();
    } catch (e) {
        recordFetchOutcome(hostOf(url), "error");
        const msg = e instanceof Error ? e.message : String(e);
        return { ok: false, kind: "network", error: `Fetch failed: ${msg}` };
    }

    const parsed = CCResponseSchema.safeParse(json);
    if (!parsed.success) {
        recordFetchOutcome(hostOf(url), "broken");
        return { ok: false, kind: "shape", error: `Unexpected ClearCompany response shape: ${parsed.error.issues.slice(0, 2).map(i => i.message).join("; ")}` };
    }

    recordFetchOutcome(hostOf(url), "ok");
    return { ok: true, data: parsed.data };
}
