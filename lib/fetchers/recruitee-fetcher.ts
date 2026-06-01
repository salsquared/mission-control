/**
 * Recruitee public offers fetcher.
 *
 * https://<slug>.recruitee.com/api/offers/ — returns all offers, no auth,
 * no pagination. Mostly used by European companies.
 *
 * Errors are returned, not thrown.
 */
import { z } from "zod";
import type { RecruiteeConfigSchema } from "@/lib/schemas/watchlists";
import type { RawPosting, FetcherResult } from "./careers-page-fetcher";
import { pickEmploymentType } from "./employment-type";
import { loggedFetch, hostOf } from "@/lib/external-fetch";
import { recordFetchOutcome } from "@/lib/fetcher-health/store";

type RecruiteeConfig = z.infer<typeof RecruiteeConfigSchema>;

const RecruiteeOfferSchema = z.object({
    id: z.number(),
    title: z.string(),
    slug: z.string().nullable().optional(),
    careers_url: z.string().nullable().optional(),
    careers_apply_url: z.string().nullable().optional(),
    location: z.string().nullable().optional(),
    city: z.string().nullable().optional(),
    country: z.string().nullable().optional(),
    remote: z.boolean().nullable().optional(),
    hybrid: z.boolean().nullable().optional(),
    employment_type_code: z.string().nullable().optional(),
    department: z.string().nullable().optional(),
    status: z.string().nullable().optional(),
}).passthrough();

const RecruiteeResponseSchema = z.object({
    offers: z.array(RecruiteeOfferSchema),
});

const FETCH_TIMEOUT_MS = 8_000;

// Map Recruitee's employment_type_code → our normalized EmploymentType. The
// `_permanent` / `_temporary` suffixes are about contract duration, which the
// title heuristic in pickEmploymentType doesn't catch.
function recruiteeEmploymentLabel(code: string | null | undefined): string | null {
    if (!code) return null;
    if (code.startsWith("fulltime")) return "Full-time";
    if (code.startsWith("parttime")) return "Part-time";
    if (code === "internship") return "Internship";
    if (code === "freelance" || code === "contract") return "Contract";
    if (code === "temporary") return "Temporary";
    return null;
}

export async function fetchRecruitee(config: RecruiteeConfig): Promise<FetcherResult> {
    const url = `https://${encodeURIComponent(config.boardSlug)}.recruitee.com/api/offers/`;
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

    const parsed = RecruiteeResponseSchema.safeParse(json);
    if (!parsed.success) {
        recordFetchOutcome(hostOf(url), "broken");
        return { ok: false, error: `Unexpected Recruitee response shape: ${parsed.error.issues.slice(0, 2).map(i => i.message).join("; ")}` };
    }

    recordFetchOutcome(hostOf(url), "ok");

    const postings: RawPosting[] = parsed.data.offers
        .filter(o => o.title && (o.careers_url || o.slug))
        .map(o => {
            const employmentLabel = recruiteeEmploymentLabel(o.employment_type_code);
            const remoteTag = o.remote ? "Remote" : o.hybrid ? "Hybrid" : null;
            return {
                company: config.companyName,
                title: o.title,
                sourceUrl: o.careers_url ?? `https://${config.boardSlug}.recruitee.com/o/${o.slug}`,
                location: o.location ?? ([o.city, o.country].filter(Boolean).join(", ") || null),
                snippet: [o.department, employmentLabel, remoteTag].filter(Boolean).join(" · ") || null,
                employmentType: pickEmploymentType(employmentLabel, o.title),
            };
        });

    return { ok: true, postings };
}
