/**
 * Workable public widget fetcher.
 *
 * https://apply.workable.com/api/v1/widget/accounts/<slug>?details=true
 * — returns the full open-jobs list in one shot. No auth, no pagination.
 *
 * Used by Workable itself ("careers") and many ~50–500-person companies.
 *
 * Errors are returned, not thrown.
 */
import { z } from "zod";
import type { WorkableConfigSchema } from "@/lib/schemas/watchlists";
import type { RawPosting, FetcherResult } from "./careers-page-fetcher";
import { pickEmploymentType } from "./employment-type";
import { loggedFetch, hostOf } from "@/lib/external-fetch";
import { recordFetchOutcome } from "@/lib/fetcher-health/store";

type WorkableConfig = z.infer<typeof WorkableConfigSchema>;

const WorkableJobSchema = z.object({
    title: z.string(),
    shortcode: z.string(),
    code: z.string().nullable().optional(),
    employment_type: z.string().nullable().optional(),
    telecommuting: z.boolean().nullable().optional(),
    department: z.string().nullable().optional(),
    url: z.string().nullable().optional(),
    application_url: z.string().nullable().optional(),
    published_on: z.string().nullable().optional(),
    country: z.string().nullable().optional(),
    city: z.string().nullable().optional(),
    state: z.string().nullable().optional(),
}).passthrough();

const WorkableResponseSchema = z.object({
    name: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    jobs: z.array(WorkableJobSchema),
});

const FETCH_TIMEOUT_MS = 8_000;

export async function fetchWorkable(config: WorkableConfig): Promise<FetcherResult> {
    const url = `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(config.boardSlug)}?details=true`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let json: unknown;
    try {
        // record: false — defer to the parse-aware outcome below so one fetch =
        // one health row (a 200 with an unexpected shape is `broken`, not `ok`).
        const res = await loggedFetch(url, {
            headers: {
                "User-Agent": "mission-control-watcher/1.0 (+https://mc.local; personal job-search agent)",
                "Accept": "application/json",
            },
            signal: controller.signal,
        }, { record: false });
        clearTimeout(timeoutId);
        if (!res.ok) {
            recordFetchOutcome(hostOf(url), "error");
            return { ok: false, error: `HTTP ${res.status} ${res.statusText} from ${url}` };
        }
        json = await res.json();
    } catch (e) {
        clearTimeout(timeoutId);
        recordFetchOutcome(hostOf(url), "error");
        const msg = e instanceof Error ? e.message : String(e);
        return { ok: false, error: `Fetch failed: ${msg}` };
    }

    const parsed = WorkableResponseSchema.safeParse(json);
    if (!parsed.success) {
        recordFetchOutcome(hostOf(url), "broken");
        return { ok: false, error: `Unexpected Workable response shape: ${parsed.error.issues.slice(0, 2).map(i => i.message).join("; ")}` };
    }

    recordFetchOutcome(hostOf(url), "ok");

    const postings: RawPosting[] = parsed.data.jobs
        .filter(j => j.url || j.shortcode)
        .map(j => {
            const remoteTag = j.telecommuting ? "Remote" : null;
            const location = [j.city, j.state, j.country].filter(s => s && s.trim()).join(", ") || (remoteTag ?? null);
            return {
                company: config.companyName,
                title: j.title,
                sourceUrl: j.url ?? `https://apply.workable.com/j/${encodeURIComponent(j.shortcode)}`,
                location,
                snippet: [j.department, j.employment_type, remoteTag && !location?.includes("Remote") ? "Remote" : null].filter(Boolean).join(" · ") || null,
                employmentType: pickEmploymentType(j.employment_type, j.title),
            };
        });

    return { ok: true, postings };
}
