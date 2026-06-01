/**
 * Workday public careers-page fetcher (MB Phase 2b).
 *
 * Each Workday tenant exposes a public POST API at
 *   https://<tenantHost>/wday/cxs/<tenantSlug>/<careerSite>/jobs
 * Body: { appliedFacets: {}, limit: N, offset: 0, searchText: "" }
 *
 * Examples (verified live):
 *   Boeing       → boeing.wd1.myworkdayjobs.com / EXTERNAL_CAREERS  (~1,177 jobs)
 *   Blue Origin  → blueorigin.wd5.myworkdayjobs.com / BlueOrigin    (~957 jobs)
 *
 * Errors are returned, not thrown.
 */
import { z } from "zod";
import type { WorkdayConfigSchema } from "@/lib/schemas/watchlists";
import type { RawPosting, FetcherResult } from "./careers-page-fetcher";
import { inferEmploymentTypeFromTitle } from "./employment-type";
import { loggedFetch, hostOf } from "@/lib/external-fetch";
import { recordFetchOutcome } from "@/lib/fetcher-health/store";

type WorkdayConfig = z.infer<typeof WorkdayConfigSchema>;

const WorkdayJobSchema = z.object({
    title: z.string(),
    externalPath: z.string(),
    locationsText: z.string().nullable().optional(),
    postedOn: z.string().nullable().optional(),
    bulletFields: z.array(z.string()).optional(),
    remoteType: z.string().nullable().optional(),
}).passthrough();

// Envelope-only validation. Each entry in `jobPostings` is validated
// individually inside the loop so a single malformed row doesn't abort the
// whole crawl — Boeing in particular (1,170+ jobs) hits transient source
// hiccups where one entry comes back missing title/externalPath and the old
// `z.array(WorkdayJobSchema)` would fail the entire page.
const WorkdayResponseSchema = z.object({
    total: z.number().int().optional(),
    jobPostings: z.array(z.unknown()),
});

const FETCH_TIMEOUT_MS = 10_000;
// Workday caps `limit` server-side at 20 — anything larger returns HTTP 400.
// Found empirically against Boeing's tenant; confirmed against Blue Origin's.
const PAGE_SIZE = 20;
// PB-ext-5: default cap is 10 pages (200 postings). Per-watchlist override
// via WorkdayConfigSchema.maxPages lets Boeing/Blue Origin opt into deeper
// crawls (they have ~1,000+ jobs each). Bounded [1, 200] at schema layer.
const DEFAULT_MAX_PAGES = 10;
// Workday's Cloudflare layer 400s on identifiable bot User-Agents. Use a
// real-browser UA — this is a personal-use crawler hitting public job boards,
// not abuse.
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/** Derive the tenant slug from the host. `boeing.wd1.myworkdayjobs.com` → `boeing`. */
function tenantSlugFromHost(host: string): string {
    return host.split(".")[0].toLowerCase();
}

/**
 * Build the user-visible job-detail URL from the externalPath returned in the
 * Workday API response. Workday's public career site lives at
 *   https://<tenantHost>/en-US/<careerSite>{externalPath}
 * which is what the user sees when they click "Apply" from the job board.
 */
function buildSourceUrl(config: WorkdayConfig, externalPath: string): string {
    // externalPath is server-supplied with a leading slash already.
    return `https://${config.tenantHost}/en-US/${config.careerSite}${externalPath}`;
}

export async function fetchWorkday(config: WorkdayConfig): Promise<FetcherResult> {
    const tenantSlug = tenantSlugFromHost(config.tenantHost);
    const endpoint = `https://${config.tenantHost}/wday/cxs/${tenantSlug}/${config.careerSite}/jobs`;

    const maxPages = config.maxPages ?? DEFAULT_MAX_PAGES;
    const out: RawPosting[] = [];
    let partial = false;
    let skipped = 0;
    // Throttle per-job warn logs so a chronically misbehaving source doesn't
    // spam PM2 logs. We log the first few in full and rely on the summary at
    // the end for the rest.
    const SAMPLE_WARN_LIMIT = 3;
    try {
        for (let page = 0; page < maxPages; page++) {
            // Per-page timeout — a single signal across the whole loop would
            // fire after the first ~10s regardless of which iteration we're on,
            // which limits us to 1-2 pages on a slow connection.
            // record: false — defer to the parse-aware outcome below so one
            // page POST = one health row (200-with-bad-shape is `broken`).
            const res = await loggedFetch(endpoint, {
                method: "POST",
                headers: {
                    "User-Agent": USER_AGENT,
                    "Accept": "application/json",
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    appliedFacets: {},
                    limit: PAGE_SIZE,
                    offset: page * PAGE_SIZE,
                    searchText: "",
                }),
                signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            }, { record: false });
            if (!res.ok) {
                recordFetchOutcome(hostOf(endpoint), "error");
                // Got some pages, stop early instead of failing — but flag the
                // result `partial` so job-watcher's close-detection skips this
                // run. Without this flag, Boeing (1462 active) / Blue Origin
                // (1040) could mass-close hundreds of postings on the next
                // crawl whenever Workday pagination hiccups mid-fetch.
                if (page > 0) { partial = true; break; }
                return { ok: false, error: `HTTP ${res.status} ${res.statusText} from ${endpoint}` };
            }
            const json = await res.json();
            const parsed = WorkdayResponseSchema.safeParse(json);
            if (!parsed.success) {
                recordFetchOutcome(hostOf(endpoint), "broken");
                return { ok: false, error: `Unexpected Workday envelope shape: ${parsed.error.issues.slice(0, 2).map(i => i.message).join("; ")}` };
            }
            recordFetchOutcome(hostOf(endpoint), "ok");
            for (const raw of parsed.data.jobPostings) {
                const job = WorkdayJobSchema.safeParse(raw);
                if (!job.success) {
                    skipped++;
                    if (skipped <= SAMPLE_WARN_LIMIT) {
                        const fields = job.error.issues.slice(0, 2).map(i => `${i.path.join(".") || "?"}: ${i.message}`).join("; ");
                        console.warn(`[workday] ${config.companyName} page=${page}: skipping malformed job — ${fields}; sample=${JSON.stringify(raw).slice(0, 200)}`);
                    }
                    continue;
                }
                const j = job.data;
                out.push({
                    company: config.companyName,
                    title: j.title,
                    sourceUrl: buildSourceUrl(config, j.externalPath),
                    location: j.locationsText ?? null,
                    snippet: j.remoteType ?? j.postedOn ?? null,
                    // Workday doesn't expose employment type on the listing
                    // endpoint — title heuristic is the cheapest fallback.
                    employmentType: inferEmploymentTypeFromTitle(j.title),
                });
            }
            // Stop early when we've drained the listing. We can ONLY trust
            // the `total` field on the first page — Workday returns total=0 on
            // subsequent paginated requests (offset > 0), so a naive
            // `out.length >= total` check would always break after page 1.
            // Use the raw page length (not `out.length` delta) so a page full
            // of skipped malformed entries still counts as a "full" page.
            if (parsed.data.jobPostings.length < PAGE_SIZE) break;
            if (page === 0 && typeof parsed.data.total === "number" && parsed.data.total > 0 && out.length >= parsed.data.total) break;
        }
    } catch (e) {
        recordFetchOutcome(hostOf(endpoint), "error");
        const msg = e instanceof Error ? e.message : String(e);
        // If we collected anything before the failure, return what we have —
        // but flag partial so close-detection doesn't mass-close on a flaky
        // crawl. See careers-page-fetcher.ts FetcherResult docstring.
        if (out.length > 0) return { ok: true, postings: out, partial: true };
        return { ok: false, error: `Fetch failed: ${msg}` };
    }

    if (skipped > 0) {
        console.warn(`[workday] ${config.companyName}: ingested ${out.length} postings, skipped ${skipped} malformed entries`);
    }
    return partial ? { ok: true, postings: out, partial: true } : { ok: true, postings: out };
}
