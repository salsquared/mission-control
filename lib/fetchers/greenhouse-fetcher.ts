/**
 * Greenhouse public boards API fetcher (MB Phase 1).
 *
 * Many companies (Anthropic, Stripe, Rocket Lab, Vercel, ...) publish their
 * jobs at https://boards-api.greenhouse.io/v1/boards/<slug>/jobs as JSON.
 * That's the canonical source — far more reliable than scraping a careers
 * page that's a SPA.
 *
 * Errors are returned, not thrown.
 */
import { z } from "zod";
import type { GreenhouseConfigSchema } from "@/lib/schemas/watchlists";
import type { RawPosting, FetcherResult } from "./careers-page-fetcher";

type GreenhouseConfig = z.infer<typeof GreenhouseConfigSchema>;

const GreenhouseLocationSchema = z.object({
    name: z.string().nullable().optional(),
}).optional();

const GreenhouseJobSchema = z.object({
    id: z.number(),
    title: z.string(),
    absolute_url: z.string(),
    location: GreenhouseLocationSchema,
    updated_at: z.string().optional(),
    departments: z.array(z.object({ name: z.string() })).optional(),
});

const GreenhouseBoardSchema = z.object({
    jobs: z.array(GreenhouseJobSchema),
});

const FETCH_TIMEOUT_MS = 8_000;

export async function fetchGreenhouse(config: GreenhouseConfig): Promise<FetcherResult> {
    const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(config.boardSlug)}/jobs`;
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

    const parsed = GreenhouseBoardSchema.safeParse(json);
    if (!parsed.success) {
        return { ok: false, error: `Unexpected Greenhouse response shape: ${parsed.error.issues.slice(0, 2).map(i => i.message).join("; ")}` };
    }

    const postings: RawPosting[] = parsed.data.jobs.map(j => ({
        company: config.companyName,
        title: j.title,
        sourceUrl: j.absolute_url,
        location: j.location?.name ?? null,
        snippet: j.departments?.map(d => d.name).join(", ") ?? null,
    }));

    return { ok: true, postings };
}
