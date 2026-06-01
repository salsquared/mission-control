/**
 * Ashby public job-board API fetcher (MB Phase 2).
 *
 * https://api.ashbyhq.com/posting-api/job-board/<slug>
 * Used by Notion, PostHog, many AI-era companies.
 */
import { z } from "zod";
import type { AshbyConfigSchema } from "@/lib/schemas/watchlists";
import type { RawPosting, FetcherResult } from "./careers-page-fetcher";
import { pickEmploymentType } from "./employment-type";
import { loggedFetch, hostOf } from "@/lib/external-fetch";
import { recordFetchOutcome } from "@/lib/fetcher-health/store";

type AshbyConfig = z.infer<typeof AshbyConfigSchema>;

const AshbyJobSchema = z.object({
    id: z.string(),
    title: z.string(),
    locationName: z.string().nullable().optional(),
    departmentName: z.string().nullable().optional(),
    teamName: z.string().nullable().optional(),
    employmentType: z.string().nullable().optional(),
    jobUrl: z.string(),
    publishedAt: z.string().nullable().optional(),
}).passthrough();

const AshbyResponseSchema = z.object({
    jobs: z.array(AshbyJobSchema),
});

const FETCH_TIMEOUT_MS = 8_000;

export async function fetchAshby(config: AshbyConfig): Promise<FetcherResult> {
    const url = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(config.boardSlug)}`;
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

    const parsed = AshbyResponseSchema.safeParse(json);
    if (!parsed.success) {
        recordFetchOutcome(hostOf(url), "broken");
        return { ok: false, error: `Unexpected Ashby response shape: ${parsed.error.issues.slice(0, 2).map(i => i.message).join("; ")}` };
    }

    recordFetchOutcome(hostOf(url), "ok");

    const postings: RawPosting[] = parsed.data.jobs.map(j => ({
        company: config.companyName,
        title: j.title,
        sourceUrl: j.jobUrl,
        location: j.locationName ?? null,
        snippet: [j.departmentName, j.teamName, j.employmentType].filter(Boolean).join(" · ") || null,
        employmentType: pickEmploymentType(j.employmentType, j.title),
    }));

    return { ok: true, postings };
}
