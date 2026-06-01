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
import { pickEmploymentType } from "./employment-type";
import { loggedFetch, hostOf } from "@/lib/external-fetch";
import { recordFetchOutcome } from "@/lib/fetcher-health/store";

type GreenhouseConfig = z.infer<typeof GreenhouseConfigSchema>;

const GreenhouseLocationSchema = z.object({
    name: z.string().nullable().optional(),
}).optional();

// Greenhouse `metadata` is an array of company-configured key/value pairs.
// Most companies don't expose Employment Type here — but the ones that do
// (e.g. Rocket Lab) cover 100% of their listings, so it's by far the
// highest-yield signal when present.
const GreenhouseMetadataSchema = z.object({
    name: z.string().nullable().optional(),
    value: z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.string())]).optional(),
}).passthrough();

const GreenhouseJobSchema = z.object({
    id: z.number(),
    title: z.string(),
    absolute_url: z.string(),
    location: GreenhouseLocationSchema,
    updated_at: z.string().optional(),
    departments: z.array(z.object({ name: z.string() })).optional(),
    metadata: z.array(GreenhouseMetadataSchema).nullable().optional(),
});

const GreenhouseBoardSchema = z.object({
    jobs: z.array(GreenhouseJobSchema),
});

const EMPLOYMENT_TYPE_METADATA_KEY = /^\s*(employment|position|job)\s+type\s*$/i;

function readMetadataEmploymentType(metadata: z.infer<typeof GreenhouseJobSchema>["metadata"]): string | null {
    if (!metadata) return null;
    for (const m of metadata) {
        if (!m.name || !EMPLOYMENT_TYPE_METADATA_KEY.test(m.name)) continue;
        const v = m.value;
        if (typeof v === "string") return v;
        if (Array.isArray(v) && v.length > 0 && typeof v[0] === "string") return v[0];
    }
    return null;
}

const FETCH_TIMEOUT_MS = 8_000;

export async function fetchGreenhouse(config: GreenhouseConfig): Promise<FetcherResult> {
    // `?content=true` makes Greenhouse include the `metadata` array on every
    // job (which is how companies like Rocket Lab expose "Employment Type"),
    // at the cost of a much larger payload — Anthropic's board grows from
    // ~100KB to ~6MB. Cached in `withCache` so it's one fetch per TTL.
    const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(config.boardSlug)}/jobs?content=true`;
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

    const parsed = GreenhouseBoardSchema.safeParse(json);
    if (!parsed.success) {
        recordFetchOutcome(hostOf(url), "broken");
        return { ok: false, error: `Unexpected Greenhouse response shape: ${parsed.error.issues.slice(0, 2).map(i => i.message).join("; ")}` };
    }

    recordFetchOutcome(hostOf(url), "ok");

    const postings: RawPosting[] = parsed.data.jobs.map(j => ({
        company: config.companyName,
        title: j.title,
        sourceUrl: j.absolute_url,
        location: j.location?.name ?? null,
        snippet: j.departments?.map(d => d.name).join(", ") ?? null,
        // Prefer the company-configured metadata field (Rocket Lab covers
        // 100% of jobs this way); fall back to title-keyword inference.
        // Greenhouse's body content is too noisy to scan ("4 months of
        // full-time research" in a fellowship JD would mis-label).
        employmentType: pickEmploymentType(readMetadataEmploymentType(j.metadata), j.title),
    }));

    return { ok: true, postings };
}
