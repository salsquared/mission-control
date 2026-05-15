/**
 * Lever public postings API fetcher (MB Phase 2).
 *
 * https://api.lever.co/v0/postings/<slug> — flat array of jobs.
 * Used by Spotify and many Y Combinator-adjacent companies.
 */
import { z } from "zod";
import type { LeverConfigSchema } from "@/lib/schemas/watchlists";
import type { RawPosting, FetcherResult } from "./careers-page-fetcher";

type LeverConfig = z.infer<typeof LeverConfigSchema>;

const LeverPostingSchema = z.object({
    id: z.string().nullable().optional(),
    text: z.string().nullable().optional(),
    hostedUrl: z.string().nullable().optional(),
    categories: z.object({
        location: z.string().nullable().optional(),
        department: z.string().nullable().optional(),
        team: z.string().nullable().optional(),
        commitment: z.string().nullable().optional(),
    }).nullable().optional(),
}).passthrough();

const LeverResponseSchema = z.array(LeverPostingSchema);

const FETCH_TIMEOUT_MS = 8_000;

export async function fetchLever(config: LeverConfig): Promise<FetcherResult> {
    const url = `https://api.lever.co/v0/postings/${encodeURIComponent(config.boardSlug)}`;
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

    // Lever returns `{ ok: false, error: "Document not found" }` for unknown slugs even with HTTP 200 in some cases.
    if (json && typeof json === "object" && !Array.isArray(json) && "error" in json) {
        return { ok: false, error: String((json as { error: unknown }).error) };
    }

    const parsed = LeverResponseSchema.safeParse(json);
    if (!parsed.success) {
        return { ok: false, error: `Unexpected Lever response shape: ${parsed.error.issues.slice(0, 2).map(i => i.message).join("; ")}` };
    }

    const postings: RawPosting[] = parsed.data
        .filter(j => j.text && j.hostedUrl) // skip null/incomplete rows
        .map(j => ({
            company: config.companyName,
            title: j.text as string,
            sourceUrl: j.hostedUrl as string,
            location: j.categories?.location ?? null,
            snippet: [j.categories?.department, j.categories?.team, j.categories?.commitment]
                .filter(Boolean)
                .join(" · ") || null,
        }));

    return { ok: true, postings };
}
