/**
 * Careers-page fetcher (MB Phase 1).
 *
 * Given a watchlist config, GET the rootUrl, extract every <a> whose resolved
 * href matches the configured `linkPattern` regex, and return one RawPosting
 * per unique match. Polite (custom UA, 8s timeout, single concurrent request).
 *
 * Errors are returned, not thrown — caller logs `lastError` on the watchlist.
 */
import * as cheerio from "cheerio";
import type { CareersPageConfigSchema } from "@/lib/schemas/watchlists";
import { z } from "zod";
import { assertExternalHttpUrl, assertSafeResponseUrl, UnsafeURLError } from "@/lib/security/url-guard";
import { inferEmploymentTypeFromTitle } from "./employment-type";
import { loggedFetch, hostOf } from "@/lib/external-fetch";
import { recordFetchOutcome } from "@/lib/fetcher-health/store";

type CareersPageConfig = z.infer<typeof CareersPageConfigSchema>;

export interface RawPosting {
    company: string;
    title: string;
    sourceUrl: string;
    location: string | null;
    snippet: string | null;
    // PB-15: normalized employment type for the new-postings filter UI.
    // Fetchers populate from the ATS payload when available, else infer from
    // the title. Null when neither source had a signal.
    employmentType?: import("./employment-type").EmploymentType | null;
}

export type FetcherResult =
    | { ok: true; postings: RawPosting[]; partial?: boolean }
    | { ok: false; error: string };

// `partial: true` tells job-watcher's close-detection to NOT mark stale rows
// as closed for this run — the fetch returned a partial-but-non-empty result
// (pagination broke mid-way, etc.) and we can't tell what's actually still
// posted vs what dropped off the source feed. Without this flag, a partial
// fetch over a 6h window would mass-close legitimate postings the next time
// close-detection fired. See lib/fetchers/{linkedin,workday}-fetcher.ts for
// the `if (page > 0) break` paths that legitimately set this.

const USER_AGENT = "mission-control-watcher/1.0 (+https://mc.local; personal job-search agent)";
const FETCH_TIMEOUT_MS = 8_000;
const MAX_TITLE_CHARS = 200;
const MAX_POSTINGS = 200; // hard cap to keep one watchlist from blowing up the feed

function clean(s: string): string {
    return s.replace(/\s+/g, " ").trim();
}

function tryResolveURL(href: string, base: string): string | null {
    try {
        return new URL(href, base).toString();
    } catch {
        return null;
    }
}

export async function fetchCareersPage(config: CareersPageConfig): Promise<FetcherResult> {
    try {
        assertExternalHttpUrl(config.rootUrl);
    } catch (e) {
        if (e instanceof UnsafeURLError) return { ok: false, error: e.message };
        throw e;
    }

    let pattern: RegExp;
    try {
        pattern = new RegExp(config.linkPattern);
    } catch (e) {
        return { ok: false, error: `Invalid linkPattern regex: ${e instanceof Error ? e.message : String(e)}` };
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let html: string;
    try {
        // record: false — own the outcome so one fetch = one health row.
        const res = await loggedFetch(config.rootUrl, {
            headers: {
                "User-Agent": USER_AGENT,
                "Accept": "text/html,application/xhtml+xml",
                "Accept-Language": "en-US,en;q=0.9",
            },
            redirect: "follow",
            signal: controller.signal,
        }, { record: false });
        clearTimeout(timeoutId);
        if (!res.ok) {
            recordFetchOutcome(hostOf(config.rootUrl), "error");
            return { ok: false, error: `HTTP ${res.status} ${res.statusText} from ${config.rootUrl}` };
        }
        // If redirects landed on an internal target, refuse.
        try {
            assertSafeResponseUrl(res);
        } catch (e) {
            if (e instanceof UnsafeURLError) {
                recordFetchOutcome(hostOf(config.rootUrl), "error");
                return { ok: false, error: e.message };
            }
            throw e;
        }
        html = await res.text();
    } catch (e) {
        clearTimeout(timeoutId);
        recordFetchOutcome(hostOf(config.rootUrl), "error");
        const msg = e instanceof Error ? e.message : String(e);
        return { ok: false, error: `Fetch failed: ${msg}` };
    }

    const $ = cheerio.load(html);
    const seen = new Set<string>();
    const out: RawPosting[] = [];

    $("a[href]").each((_i, el) => {
        if (out.length >= MAX_POSTINGS) return false; // break cheerio loop
        const href = $(el).attr("href");
        if (!href) return;
        const resolved = tryResolveURL(href, config.rootUrl);
        if (!resolved) return;
        if (!pattern.test(resolved)) return;
        if (seen.has(resolved)) return;
        seen.add(resolved);

        let title = clean($(el).text());
        if (!title) title = clean($(el).attr("title") ?? $(el).attr("aria-label") ?? "");
        if (!title || title.length > MAX_TITLE_CHARS) return;
        // Reject titles that are clearly nav: too short or matches generic words alone.
        if (title.length < 3) return;

        // Look for an obvious location hint in nearby text. Strict: only accept
        // "City, ST" (comma + 2-letter state abbrev) or the literal work-mode
        // strings. Bare single capitalized words like "Engineering" or "Apply"
        // produce far more garbage than signal — better to return null.
        const parentText = clean($(el).parent().text());
        const locationMatch = parentText.match(/\b([A-Z][a-zA-Z.\-]+(?:[\s.][A-Z][a-zA-Z.\-]+)*,\s*[A-Z]{2}|Remote|Hybrid|On-site|On site)\b/);
        const location = locationMatch ? clean(locationMatch[0]) : null;

        out.push({
            company: config.companyName,
            title,
            sourceUrl: resolved,
            location,
            snippet: null,
            employmentType: inferEmploymentTypeFromTitle(title),
        });
    });

    // Reached + parsed the page (200, safe target). An empty result is
    // legitimate here (regex simply matched nothing), so this is `ok`, never
    // `broken` — unlike the ATS APIs we don't have a "this shape is wrong" signal.
    recordFetchOutcome(hostOf(config.rootUrl), "ok");
    return { ok: true, postings: out };
}
