/**
 * SmartRecruiters public job-board API fetcher.
 *
 * https://api.smartrecruiters.com/v1/companies/<slug>/postings — paginated.
 * No auth. Slugs are case-sensitive ("Visa" works, "visa" returns 0).
 * Used by Visa, ServiceNow, Ubisoft, Bosch, McDonald's, IKEA, etc.
 *
 * Errors are returned, not thrown.
 */
import { z } from "zod";
import type { SmartRecruitersConfigSchema } from "@/lib/schemas/watchlists";
import type { RawPosting, FetcherResult } from "./careers-page-fetcher";
import { pickEmploymentType } from "./employment-type";
import { loggedFetch, hostOf } from "@/lib/external-fetch";
import { recordFetchOutcome } from "@/lib/fetcher-health/store";

type SmartRecruitersConfig = z.infer<typeof SmartRecruitersConfigSchema>;

const SRLocationSchema = z.object({
    city: z.string().nullable().optional(),
    region: z.string().nullable().optional(),
    country: z.string().nullable().optional(),
    fullLocation: z.string().nullable().optional(),
    remote: z.boolean().nullable().optional(),
}).nullable().optional();

const SRLabeledSchema = z.object({
    id: z.string().nullable().optional(),
    label: z.string().nullable().optional(),
}).nullable().optional();

const SRPostingSchema = z.object({
    id: z.string(),
    name: z.string(),
    refNumber: z.string().nullable().optional(),
    releasedDate: z.string().nullable().optional(),
    location: SRLocationSchema,
    department: SRLabeledSchema,
    function: SRLabeledSchema,
    typeOfEmployment: SRLabeledSchema,
}).passthrough();

const SRResponseSchema = z.object({
    offset: z.number(),
    limit: z.number(),
    totalFound: z.number(),
    content: z.array(SRPostingSchema),
});

const PAGE_SIZE = 100; // SmartRecruiters' per-page maximum
const DEFAULT_MAX_PAGES = 5; // 500 postings — covers nearly every board
const FETCH_TIMEOUT_MS = 8_000;

export async function fetchSmartRecruiters(config: SmartRecruitersConfig): Promise<FetcherResult> {
    const maxPages = config.maxPages ?? DEFAULT_MAX_PAGES;
    const postings: RawPosting[] = [];

    for (let page = 0; page < maxPages; page++) {
        const offset = page * PAGE_SIZE;
        const url = `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(config.boardSlug)}/postings?limit=${PAGE_SIZE}&offset=${offset}`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

        let json: unknown;
        try {
            // record: false — defer to the parse-aware outcome below so one
            // page fetch = one health row (200-with-bad-shape is `broken`).
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

        const parsed = SRResponseSchema.safeParse(json);
        if (!parsed.success) {
            recordFetchOutcome(hostOf(url), "broken");
            return { ok: false, error: `Unexpected SmartRecruiters response shape: ${parsed.error.issues.slice(0, 2).map(i => i.message).join("; ")}` };
        }

        recordFetchOutcome(hostOf(url), "ok");

        for (const p of parsed.data.content) {
            const composed = [p.location?.city, p.location?.region, p.location?.country].filter(Boolean).join(", ");
            const location = p.location?.fullLocation ?? (composed.length > 0 ? composed : null);
            const remoteTag = p.location?.remote ? "Remote" : null;
            const snippet = [p.department?.label, p.function?.label, remoteTag].filter(Boolean).join(" · ") || null;
            postings.push({
                company: config.companyName,
                title: p.name,
                // Candidate-facing URL; verified 200 via curl on ServiceNow.
                sourceUrl: `https://jobs.smartrecruiters.com/${encodeURIComponent(config.boardSlug)}/${encodeURIComponent(p.id)}`,
                location,
                snippet,
                employmentType: pickEmploymentType(p.typeOfEmployment?.label, p.name),
            });
        }

        // Stop early if we've drained the board.
        if (offset + parsed.data.content.length >= parsed.data.totalFound) break;
        if (parsed.data.content.length === 0) break;
    }

    return { ok: true, postings };
}
