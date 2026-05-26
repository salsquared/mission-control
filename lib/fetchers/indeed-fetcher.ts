/**
 * Indeed public-guest job-search scraper.
 *
 * Indeed has no open public Jobs API (the legacy publisher API was killed in
 * 2020). The user-facing search page at
 *   https://www.indeed.com/jobs?q=…&l=…&fromage=…
 * returns HTML cards keyed by `data-jk` (Indeed's stable job-key attribute).
 * We parse those with cheerio.
 *
 *   ⚠️  FRAGILE: Indeed runs aggressive Cloudflare + bot detection and shifts
 *   card classnames on a cadence of months. This fetcher WILL break at some
 *   point — when that happens, open the same URL in a real browser with the
 *   same User-Agent string, inspect the new card structure, and update the
 *   selectors below. We anchor on the `data-jk` attribute (stable since
 *   2018) and use `data-testid` selectors as the second-most-stable shape;
 *   classname-based selectors are the last-resort fallback.
 *
 * Cadence: like LinkedIn, prefer ≥60min between fetches per watchlist. Don't
 * crawl multiple Indeed watchlists in parallel — keep the request rate low
 * so Cloudflare doesn't ladder us up to a CAPTCHA challenge.
 *
 * 24h / 25-per-page × 2 pages = 50/crawl mean the returned set is a
 * snapshot of what Indeed surfaces today, NOT the full live-posting universe.
 * Older / off-page postings still live on Indeed; the probe gate in
 * scheduler/jobs/job-watcher.ts (docs/close-detection-probe.md) prevents
 * those from being false-closed.
 */
import * as cheerio from "cheerio";
import { z } from "zod";
import type { IndeedConfigSchema } from "@/lib/schemas/watchlists";
import type { RawPosting, FetcherResult } from "./careers-page-fetcher";
import { inferEmploymentTypeFromTitle } from "./employment-type";

type IndeedConfig = z.infer<typeof IndeedConfigSchema>;

const FETCH_TIMEOUT_MS = 10_000;
const PAGE_SIZE = 25;     // Indeed's default-ish page size for guest search.
const MAX_PAGES = 2;      // 50/crawl cap, same shape as LinkedIn.
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// Cloudflare's middle-tier bot management blocks requests that don't look
// like a real Chrome navigation. We mimic the full sec-ch-ua + sec-fetch
// header set Chrome sends on a top-level page load. This isn't a bypass —
// Cloudflare also fingerprints TLS / JS execution / mouse signals — but it
// clears the cheap headers-only checks that 403'd us first.
//
// If Cloudflare is on its UPPER-tier "Just a moment..." JS challenge, no
// amount of header massaging will help; we'd need a real headless browser
// (Playwright) and that's a bigger architectural lift. Watch the fetcher
// errors: 403 = headers tier (this set should help), HTML "Just a moment"
// body = JS challenge tier (needs Playwright).
const BROWSER_HEADERS: Record<string, string> = {
    "User-Agent": USER_AGENT,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Upgrade-Insecure-Requests": "1",
    "Cache-Control": "max-age=0",
    "sec-ch-ua": '"Chromium";v="120", "Google Chrome";v="120", "Not?A_Brand";v="24"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"macOS"',
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "none",
    "sec-fetch-user": "?1",
};

function clean(s: string): string {
    return s.replace(/\s+/g, " ").trim();
}

// Cloudflare's interstitial body. If we see this, we got challenged, not
// rate-limited per se — we won't get postings out and should surface a clear
// error so the user can slow the cadence (or knows it's not a 500-class bug
// on our side).
function looksLikeCloudflareChallenge(html: string): boolean {
    const h = html.toLowerCase();
    return (
        h.includes("checking your browser") ||
        h.includes("cf-challenge") ||
        h.includes("just a moment") ||
        h.includes("attention required") ||
        h.includes("cloudflare-static")
    );
}

export async function fetchIndeed(config: IndeedConfig): Promise<FetcherResult> {
    const out: RawPosting[] = [];
    const seenJks = new Set<string>();
    let partial = false;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS * MAX_PAGES);

    try {
        // Map config.timeRange → Indeed's `fromage` (days-since-posted). "any"
        // omits the param entirely so we get Indeed's default. 24h → 1 day
        // matches the LinkedIn default; recurring crawls don't need to keep
        // surfacing week-old postings.
        const FROMAGE_MAP = { "24h": "1", "week": "7", "month": "14", "any": null } as const;
        const fromage = FROMAGE_MAP[config.timeRange ?? "24h"];

        for (let page = 0; page < MAX_PAGES; page++) {
            const params = new URLSearchParams({
                q: config.keywords,
                start: String(page * PAGE_SIZE),
                sort: "date",
            });
            if (fromage) params.set("fromage", fromage);
            if (config.location) params.set("l", config.location);
            const url = `https://www.indeed.com/jobs?${params.toString()}`;

            let res: Response;
            try {
                res = await fetch(url, {
                    headers: BROWSER_HEADERS,
                    signal: controller.signal,
                });
            } catch (e) {
                if (page > 0) { partial = true; break; }
                return { ok: false, error: `Fetch failed: ${e instanceof Error ? e.message : String(e)}` };
            }

            if (res.status === 429) {
                return { ok: false, error: "Indeed rate-limited (HTTP 429). Slow the cadence." };
            }
            if (res.status === 403) {
                return { ok: false, error: "Indeed blocked the request (HTTP 403) — likely Cloudflare bot challenge. Slow the cadence." };
            }
            if (!res.ok) {
                if (page > 0) { partial = true; break; }
                return { ok: false, error: `HTTP ${res.status} ${res.statusText}` };
            }

            const html = await res.text();
            if (looksLikeCloudflareChallenge(html)) {
                return { ok: false, error: "Indeed served a Cloudflare challenge instead of search results. Slow the cadence." };
            }
            if (html.trim().length < 200) break;

            const $ = cheerio.load(html);
            let pageCount = 0;

            // Anchor on `data-jk` — Indeed's stable job-key attribute. Every
            // search-result card carries it; non-card elements (ads, recs)
            // don't.
            $("[data-jk]").each((_i, el) => {
                const $el = $(el);
                const jk = ($el.attr("data-jk") ?? "").trim();
                if (!jk || seenJks.has(jk)) return;

                // Walk up to the nearest card container so within-card
                // selectors don't accidentally cross into a neighbor.
                const $card = $el.closest("div.cardOutline, div.job_seen_beacon, li").length
                    ? $el.closest("div.cardOutline, div.job_seen_beacon, li").first()
                    : $el;

                const title =
                    clean($card.find('[data-testid="jobTitle"]').first().text()) ||
                    clean($card.find("h2.jobTitle span[title]").first().attr("title") ?? "") ||
                    clean($card.find("h2.jobTitle").first().text()) ||
                    clean($card.find("h2 a").first().text());
                if (!title) return;

                const company =
                    clean($card.find('[data-testid="company-name"]').first().text()) ||
                    clean($card.find(".companyName").first().text());

                const location =
                    clean($card.find('[data-testid="text-location"]').first().text()) ||
                    clean($card.find(".companyLocation").first().text()) || null;

                const dateText =
                    clean($card.find('[data-testid="myJobsStateDate"]').first().text()) ||
                    clean($card.find(".date").first().text());

                const snippetText =
                    clean($card.find('[data-testid="job-snippet"]').first().text()) ||
                    clean($card.find(".job-snippet").first().text());

                // Canonical posting URL — Indeed serves both /viewjob?jk=…
                // and /rc/clk?…&jk=… on cards. Reconstructing from the jk is
                // stabler than walking href params.
                const sourceUrl = `https://www.indeed.com/viewjob?jk=${encodeURIComponent(jk)}`;
                seenJks.add(jk);

                out.push({
                    // Indeed aggregates many employers under one watchlist —
                    // prefer per-card company, fall back to the watchlist's
                    // display name (mirrors LinkedIn's pattern).
                    company: company || config.companyName,
                    title,
                    sourceUrl,
                    location,
                    // Roll date + snippet into one field — the rest of the
                    // pipeline only has one snippet column. Date first so the
                    // bell-feed surface reads "Posted 2 days ago — …".
                    snippet: [dateText, snippetText].filter(Boolean).join(" — ") || null,
                    employmentType: inferEmploymentTypeFromTitle(title),
                });
                pageCount++;
            });

            if (pageCount === 0) break;
            // Indeed returns fewer than PAGE_SIZE on the last page.
            if (pageCount < PAGE_SIZE) break;
        }
    } finally {
        clearTimeout(timeoutId);
    }

    return partial ? { ok: true, postings: out, partial: true } : { ok: true, postings: out };
}
