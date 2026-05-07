import { fetchRSS, fetchScrape, fetchSNAPI, fetchGoogleNews } from '../fetchers';
import type { NewsArticle, CompanyFeedConfig } from '../fetchers/types';
import type { CompanyAdapter } from './adapter';

interface AdapterMeta {
    id: string;
    name: string;
    view: 'space' | 'ai' | 'both';
    category: string;
    ttlSeconds?: number;
}

function hostnameOf(url: string): string | undefined {
    try { return new URL(url).hostname; } catch { return undefined; }
}

// ─── Strategy factories ────────────────────────────────────────────────────

export function rssAdapter(opts: AdapterMeta & { rssUrl: string }): CompanyAdapter {
    return {
        id: opts.id,
        name: opts.name,
        view: opts.view,
        category: opts.category,
        ttlSeconds: opts.ttlSeconds,
        upstreamHost: hostnameOf(opts.rssUrl),
        fetch: () => fetchRSS(opts.name, opts.rssUrl),
    };
}

export function scrapeAdapter(opts: AdapterMeta & {
    scrapeUrl: string;
    articleRegex: RegExp;
    baseUrl: string;
    titleRegex?: RegExp;
    dateRegex?: RegExp;
    titleSuffix?: string;
    minSlugLength?: number;
    userAgent?: string;
}): CompanyAdapter {
    // fetchScrape takes the legacy CompanyFeedConfig; build it inline rather
    // than refactor the fetcher.
    const cfg: CompanyFeedConfig = {
        id: opts.id,
        name: opts.name,
        strategy: 'scrape',
        view: opts.view,
        category: opts.category,
        ttlSeconds: opts.ttlSeconds,
        scrapeUrl: opts.scrapeUrl,
        scrapeConfig: {
            articleRegex: opts.articleRegex,
            baseUrl: opts.baseUrl,
            titleRegex: opts.titleRegex,
            dateRegex: opts.dateRegex,
            titleSuffix: opts.titleSuffix,
            minSlugLength: opts.minSlugLength,
            userAgent: opts.userAgent,
        },
    };
    return {
        id: opts.id,
        name: opts.name,
        view: opts.view,
        category: opts.category,
        ttlSeconds: opts.ttlSeconds,
        upstreamHost: hostnameOf(opts.scrapeUrl),
        fetch: () => fetchScrape(cfg),
    };
}

export function snapiAdapter(opts: AdapterMeta & { snapiQuery: string }): CompanyAdapter {
    return {
        id: opts.id,
        name: opts.name,
        view: opts.view,
        category: opts.category,
        ttlSeconds: opts.ttlSeconds,
        upstreamHost: 'api.spaceflightnewsapi.net',
        fetch: () => fetchSNAPI(opts.name, opts.snapiQuery),
    };
}

export function googleNewsAdapter(opts: AdapterMeta & { googleNewsQuery: string }): CompanyAdapter {
    return {
        id: opts.id,
        name: opts.name,
        view: opts.view,
        category: opts.category,
        ttlSeconds: opts.ttlSeconds,
        upstreamHost: 'news.google.com',
        fetch: () => fetchGoogleNews(opts.name, opts.googleNewsQuery),
    };
}

export function customAdapter(opts: AdapterMeta & {
    fetcher: () => Promise<NewsArticle[]>;
    /** Optional hostname for log tagging. Custom fetchers often hit multiple
     *  upstreams; pass the canonical one if there is one. */
    upstreamHost?: string;
}): CompanyAdapter {
    return {
        id: opts.id,
        name: opts.name,
        view: opts.view,
        category: opts.category,
        ttlSeconds: opts.ttlSeconds,
        upstreamHost: opts.upstreamHost,
        fetch: opts.fetcher,
    };
}
