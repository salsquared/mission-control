/**
 * LinkedIn public-guest jobs-search scraper (MB Phase 2b).
 *
 * LinkedIn has no public Jobs API for personal use. The guest endpoint at
 *   https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search
 * returns HTML chunks containing job-search cards. We parse those with cheerio.
 *
 *   ⚠️  FRAGILE: LinkedIn aggressively bot-detects and DOM-shifts on the
 *   regular. This fetcher WILL break at some point — when that happens, open
 *   a browser DevTools session against the same URL with the same User-Agent,
 *   inspect the new card structure, and update the cheerio selectors below.
 *   The other fetchers (Greenhouse / Lever / Ashby / Workday) all hit stable
 *   JSON APIs and don't have this risk.
 *
 * Cadence: prefer ≥60min between fetches per watchlist to stay under
 * LinkedIn's anti-bot heuristics. Don't crawl multiple LinkedIn watchlists
 * in parallel — keep the request rate low.
 *
 * f_TPR=r86400 (24h window) + PAGE_SIZE 25 × MAX_PAGES 2 = 50/crawl mean
 * the returned set is a snapshot of what LinkedIn surfaces today, NOT the
 * full live-posting universe. Postings older than 24h or past slot 50 fall
 * out — they're still live on LinkedIn, but we don't see them. The probe
 * gate in scheduler/jobs/job-watcher.ts (docs/archive/close-detection-probe.md)
 * stops these from being false-closed: stale candidates get GET-probed
 * against their sourceUrl, and only positive-evidence-of-removal flips
 * the row.
 */
import * as cheerio from "cheerio";
import { z } from "zod";
import type { LinkedinConfigSchema } from "@/lib/schemas/watchlists";
import type { RawPosting, FetcherResult } from "./careers-page-fetcher";
import { inferEmploymentTypeFromTitle } from "./employment-type";

type LinkedinConfig = z.infer<typeof LinkedinConfigSchema>;

const FETCH_TIMEOUT_MS = 10_000;
const PAGE_SIZE = 25; // LinkedIn's default
const MAX_PAGES = 2;  // cap each crawl at 50 postings — stay polite
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function clean(s: string): string {
    return s.replace(/\s+/g, " ").trim();
}

export async function fetchLinkedin(config: LinkedinConfig): Promise<FetcherResult> {
    const out: RawPosting[] = [];
    const seenUrls = new Set<string>();
    let partial = false;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS * MAX_PAGES);

    try {
        // Map config.timeRange → LinkedIn's f_TPR codes. Default 24h
        // matches the historical hard-coded value (right for recurring
        // watchlist crawls — keep deltas small). One-shot discovery
        // callers can override.
        const F_TPR_MAP = { "24h": "r86400", "week": "r604800", "month": "r2592000", "any": null } as const;
        const tpr = F_TPR_MAP[config.timeRange ?? "24h"];

        for (let page = 0; page < MAX_PAGES; page++) {
            const params = new URLSearchParams({
                keywords: config.keywords,
                start: String(page * PAGE_SIZE),
            });
            if (tpr) params.set("f_TPR", tpr);
            if (config.location) params.set("location", config.location);
            const url = `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?${params.toString()}`;

            let res: Response;
            try {
                res = await fetch(url, {
                    headers: {
                        "User-Agent": USER_AGENT,
                        "Accept": "text/html,application/xhtml+xml",
                        "Accept-Language": "en-US,en;q=0.9",
                    },
                    signal: controller.signal,
                });
            } catch (e) {
                // Pagination failed mid-crawl. Keep the postings we already
                // have from earlier pages but mark the result partial so
                // close-detection doesn't mass-close postings we never got
                // a chance to re-see this run.
                if (page > 0) { partial = true; break; }
                return { ok: false, error: `Fetch failed: ${e instanceof Error ? e.message : String(e)}` };
            }

            if (res.status === 429) {
                return { ok: false, error: "LinkedIn rate-limited (HTTP 429). Slow the cadence." };
            }
            if (!res.ok) {
                if (page > 0) { partial = true; break; }
                return { ok: false, error: `HTTP ${res.status} ${res.statusText}` };
            }

            const html = await res.text();
            // Empty body = no more pages. LinkedIn returns 200 with whitespace
            // when start > total.
            if (html.trim().length < 40) break;

            const $ = cheerio.load(html);
            let pageCount = 0;

            // Each posting lives in a .base-card or .job-search-card <li>.
            $("li").each((_i, el) => {
                const $li = $(el);
                const $link = $li.find("a.base-card__full-link").first();
                const href = $link.attr("href");
                if (!href) return;
                // Strip query / tracking params — keep just the canonical job
                // URL so dedup works across pages and fetches.
                const sourceUrl = href.split("?")[0].trim();
                if (!sourceUrl.includes("/jobs/view/")) return;
                if (seenUrls.has(sourceUrl)) return;
                seenUrls.add(sourceUrl);

                const title = clean($li.find(".base-search-card__title").first().text())
                    || clean($link.find("span.sr-only").text());
                if (!title) return;
                const subtitle = clean($li.find(".base-search-card__subtitle").first().text());
                const location = clean($li.find(".job-search-card__location").first().text()) || null;
                const postedAt = clean($li.find("time[datetime]").first().attr("datetime") ?? "");

                out.push({
                    // LinkedIn aggregates many companies under one watchlist —
                    // prefer the per-posting company subtitle, fall back to the
                    // watchlist's configured display name.
                    company: subtitle || config.companyName,
                    title,
                    sourceUrl,
                    location,
                    snippet: postedAt || null,
                    // LinkedIn's guest cards don't include employment type;
                    // fall back to title-keyword inference.
                    employmentType: inferEmploymentTypeFromTitle(title),
                });
                pageCount++;
            });

            // LinkedIn returns fewer than PAGE_SIZE when we've exhausted the
            // search. Stop early.
            if (pageCount < PAGE_SIZE) break;
        }
    } finally {
        clearTimeout(timeoutId);
    }

    return partial ? { ok: true, postings: out, partial: true } : { ok: true, postings: out };
}
