/**
 * ClearCompany public job-board fetcher.
 *
 * https://careers-api.clearcompany.com/v1/<siteId> — siteId is a UUID
 * (e.g. 00ed92c3-5bfb-7bfb-456d-4d9d77fef9a5 for Firefly Aerospace), extractable
 * from the embedded
 *   <script src="https://careers-content.clearcompany.com/js/v1/career-site.js?siteId=<uuid>">
 * tag on a ClearCompany-backed careers page. No auth.
 *
 * Returns all results in one shot by default (verified against Firefly's 135-
 * job board). For larger boards the API supports ?pageIndex=N&pageSize=50;
 * we paginate defensively when totalCount > currentPageCount.
 *
 * Errors are returned, not thrown.
 */
import { z } from "zod";
import type { ClearCompanyConfigSchema } from "@/lib/schemas/watchlists";
import type { RawPosting, FetcherResult } from "./careers-page-fetcher";
import { pickEmploymentType } from "./employment-type";

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
const PAGE_SIZE = 50; // ClearCompany's per-page default when pageIndex is set
const MAX_PAGES = 20; // 1,000-posting safety cap

export async function fetchClearCompany(config: ClearCompanyConfig): Promise<FetcherResult> {
    const base = `https://careers-api.clearcompany.com/v1/${encodeURIComponent(config.boardSlug)}`;

    // First call: no pagination params. For most boards (≤ ~500 postings)
    // ClearCompany returns everything in one shot, so we avoid paginating
    // when we don't need to.
    const first = await fetchPage(base);
    if (!first.ok) return first;
    const all: z.infer<typeof CCPostingSchema>[] = [...first.data.results];

    // If we got everything in one shot, skip the loop.
    if (all.length < first.data.totalCount) {
        // Paginate from pageIndex=1 onward (pageIndex=0 was effectively the
        // unpaginated call above, but ClearCompany ignores partial overlap and
        // we'd rather over-fetch and dedup than miss rows).
        const seen = new Set<string>(all.map(p => p.id));
        for (let page = 1; page < MAX_PAGES; page++) {
            const url = `${base}?pageIndex=${page}&pageSize=${PAGE_SIZE}`;
            const next = await fetchPage(url);
            if (!next.ok) {
                // Non-fatal: keep what we have, log via lastError.
                return { ok: false, error: `Paginated fetch failed at pageIndex=${page}: ${next.error}` };
            }
            for (const p of next.data.results) {
                if (!seen.has(p.id)) {
                    all.push(p);
                    seen.add(p.id);
                }
            }
            // Stop once we've drained the board or the page came back empty.
            if (next.data.results.length === 0) break;
            if (all.length >= next.data.totalCount) break;
        }
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

    return { ok: true, postings };
}

async function fetchPage(url: string): Promise<
    | { ok: true; data: z.infer<typeof CCResponseSchema> }
    | { ok: false; error: string }
> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let json: unknown;
    try {
        const res = await fetch(url, {
            headers: {
                "User-Agent": "mission-control-watcher/1.0 (+https://mc.local; personal job-search agent)",
                "Accept": "application/json",
            },
            signal: controller.signal,
        });
        clearTimeout(timeoutId);
        if (!res.ok) {
            return { ok: false, error: `HTTP ${res.status} ${res.statusText} from ${url}` };
        }
        json = await res.json();
    } catch (e) {
        clearTimeout(timeoutId);
        const msg = e instanceof Error ? e.message : String(e);
        return { ok: false, error: `Fetch failed: ${msg}` };
    }

    const parsed = CCResponseSchema.safeParse(json);
    if (!parsed.success) {
        return { ok: false, error: `Unexpected ClearCompany response shape: ${parsed.error.issues.slice(0, 2).map(i => i.message).join("; ")}` };
    }
    return { ok: true, data: parsed.data };
}
