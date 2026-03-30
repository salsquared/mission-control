/**
 * Shared types for the company news fetcher system.
 */

export interface NewsArticle {
    id: string;
    title: string;
    url: string;
    source: string;
    published_at: string;
    image_url: string;
    news_site: string;
}

export type FetchStrategy = 'rss' | 'json-api' | 'scrape' | 'snapi' | 'google-news' | 'custom';

export interface CompanyFeedConfig {
    /** Unique identifier used as query param, e.g. 'spacex', 'blue-origin' */
    id: string;
    /** Display name shown in UI */
    name: string;
    /** Which ingestion strategy to use */
    strategy: FetchStrategy;
    /** Which dashboard view this company belongs to */
    view: 'space' | 'ai' | 'both';
    /** Subcategory for grouping in the UI, e.g. 'Prime Contractors', 'Fabless' */
    category: string;
    /** Cache TTL override in seconds. Defaults to 3600 (1hr) */
    ttlSeconds?: number;

    // ── Strategy-specific config ──

    /** RSS feed URL (strategy: 'rss') */
    rssUrl?: string;

    /** JSON API URL (strategy: 'json-api') */
    apiUrl?: string;
    /** Transform function for JSON API responses */
    apiTransform?: (data: any) => NewsArticle[];

    /** URL to scrape (strategy: 'scrape') */
    scrapeUrl?: string;
    /** Scrape configuration */
    scrapeConfig?: {
        /** Regex to extract article slugs/URLs from the page HTML. Must have at least one capture group for the slug/path. */
        articleRegex: RegExp;
        /** Base URL to prepend to extracted slugs (e.g. 'https://anthropic.com') */
        baseUrl: string;
        /** Optional regex to extract title from inner HTML of the matched anchor */
        titleRegex?: RegExp;
        /** Optional regex to extract date from inner HTML */
        dateRegex?: RegExp;
        /** Optional: strip this suffix from OGS titles */
        titleSuffix?: string;
        /** Minimum slug length to filter out generic nav links */
        minSlugLength?: number;
        /** Custom User-Agent header */
        userAgent?: string;
    };

    /** SNAPI title_contains query (strategy: 'snapi') */
    snapiQuery?: string;

    /** Google News search query (strategy: 'google-news') */
    googleNewsQuery?: string;

    /** Custom fetch function (strategy: 'custom') — for unique APIs like SpaceX, OpenAI w/ Microlink, etc. */
    customFetcher?: () => Promise<NewsArticle[]>;
}
