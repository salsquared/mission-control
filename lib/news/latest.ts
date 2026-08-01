/**
 * Cross-feed "latest news" selector (2026-07-31).
 *
 * The views fetch one article list per company feed and keep them in a
 * `Record<feedName, article[]>`. This flattens that map into a single
 * newest-first list for the hero carousel that sits above the per-company
 * cards, so a reader sees what moved most recently across ALL feeds without
 * scanning ~30 mini carousels.
 *
 * Pure + client-safe: no fetchers, no `node:*`, no Date.now(). The article
 * type is structural rather than an import of `lib/fetchers/types` — that
 * module is server-side, and the client sees these fields after JSON
 * round-tripping (where `published_at` may arrive as `publishedAt`).
 */

export interface FeedArticle {
    id?: string | number;
    title?: string;
    url?: string;
    image_url?: string;
    news_site?: string;
    source?: string;
    published_at?: string;
    publishedAt?: string;
}

export interface LatestArticle extends FeedArticle {
    title: string;
    url: string;
    /** Display name of the feed this came from — the `newsMap` key, i.e. the
     *  company we pulled it from, NOT `news_site` (which for google-news-backed
     *  feeds is the syndicating publisher, not the company being tracked). */
    feed: string;
    /** Parsed publish time in ms, or null when the feed gave no usable date. */
    publishedMs: number | null;
}

/** `published_at` is the fetcher's field; `publishedAt` shows up on some
 *  client-side shapes. Returns null for missing / unparseable dates. */
function parsePublished(article: FeedArticle): number | null {
    const raw = article.published_at || article.publishedAt;
    if (!raw) return null;
    const ms = new Date(raw).getTime();
    return Number.isNaN(ms) ? null : ms;
}

/** Strip the noise that makes the same story look like two URLs: protocol,
 *  `www.`, tracking params, trailing slash, fragment. */
function normalizeUrl(url: string): string {
    try {
        const u = new URL(url);
        for (const key of [...u.searchParams.keys()]) {
            if (key.toLowerCase().startsWith('utm_')) u.searchParams.delete(key);
        }
        const host = u.hostname.replace(/^www\./i, '').toLowerCase();
        const path = u.pathname.replace(/\/+$/, '').toLowerCase();
        return `${host}${path}${u.searchParams.toString() ? `?${u.searchParams}` : ''}`;
    } catch {
        return url.trim().toLowerCase();
    }
}

function normalizeTitle(title: string): string {
    return title.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Flatten every feed into one newest-first list.
 *
 * - Articles missing a title or url are dropped (a hero slide can't render one).
 * - Deduped on normalized url, then on normalized title — two feeds syndicating
 *   the same story (a company's own RSS + its google-news mirror) must not burn
 *   two of the `limit` slots. First occurrence wins, and because the sort runs
 *   BEFORE the dedupe, "first" is the copy with the freshest date.
 * - Undated articles sort last rather than being dropped: some scraped feeds
 *   never emit a date, and dropping them would silently hide those companies.
 *   Among equal/absent dates the original feed order is preserved.
 */
export function selectLatestArticles(
    newsMap: Record<string, FeedArticle[] | undefined>,
    limit = 10,
): LatestArticle[] {
    const flat: LatestArticle[] = [];

    for (const [feed, articles] of Object.entries(newsMap)) {
        if (!Array.isArray(articles)) continue;
        for (const article of articles) {
            if (!article?.title || !article?.url) continue;
            flat.push({ ...article, title: article.title, url: article.url, feed, publishedMs: parsePublished(article) });
        }
    }

    // Newest first, undated last. `sort` is stable in ES2019+, so ties keep
    // insertion order instead of shuffling between renders.
    flat.sort((a, b) => {
        if (a.publishedMs === null && b.publishedMs === null) return 0;
        if (a.publishedMs === null) return 1;
        if (b.publishedMs === null) return -1;
        return b.publishedMs - a.publishedMs;
    });

    const seen = new Set<string>();
    const deduped: LatestArticle[] = [];
    for (const article of flat) {
        const urlKey = `u:${normalizeUrl(article.url)}`;
        const titleKey = `t:${normalizeTitle(article.title)}`;
        if (seen.has(urlKey) || seen.has(titleKey)) continue;
        seen.add(urlKey);
        seen.add(titleKey);
        deduped.push(article);
        if (deduped.length >= limit) break;
    }

    return deduped;
}
