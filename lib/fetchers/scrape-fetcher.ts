/**
 * HTML Scrape Fetcher
 * Handles companies that don't have RSS but whose pages are fetchable.
 * Extracts article URLs via regex, then enriches with Open Graph metadata.
 */

import ogs from 'open-graph-scraper';
import { MAX_NEWS_ARTICLES } from '../constants';
import type { NewsArticle, CompanyFeedConfig } from './types';

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

/**
 * Scrape a news/blog page for article links, then enrich each with OGS metadata.
 */
export async function fetchScrape(config: CompanyFeedConfig): Promise<NewsArticle[]> {
    const { name, scrapeUrl, scrapeConfig } = config;

    if (!scrapeUrl || !scrapeConfig) {
        throw new Error(`[SCRAPE] Missing scrapeUrl or scrapeConfig for ${name}`);
    }

    console.info(`[EXTERNAL API] Scraping ${name} from: ${scrapeUrl}`);

    const res = await fetch(scrapeUrl, {
        headers: {
            'User-Agent': scrapeConfig.userAgent || DEFAULT_USER_AGENT
        }
    });

    if (!res.ok) {
        throw new Error(`Failed to fetch ${name} news page: ${res.status}`);
    }

    const html = await res.text();

    // Extract article slugs/URLs using the configured regex
    const regex = new RegExp(scrapeConfig.articleRegex.source, scrapeConfig.articleRegex.flags);
    let match;
    const seen = new Set<string>();
    const articles: NewsArticle[] = [];

    while ((match = regex.exec(html)) !== null) {
        const slug = match[1];
        if (!slug) continue;

        // Filter out slugs that are too short (likely nav links)
        if (scrapeConfig.minSlugLength && slug.length < scrapeConfig.minSlugLength) continue;

        const fullUrl = slug.startsWith('http')
            ? slug
            : `${scrapeConfig.baseUrl}${slug.startsWith('/') ? '' : '/'}${slug}`;

        // Skip duplicates
        if (seen.has(fullUrl)) continue;
        seen.add(fullUrl);

        // Try to extract title from inner HTML if regex is provided
        let title = `${name} News`;
        if (scrapeConfig.titleRegex && match[2]) {
            const titleMatch = match[2].match(scrapeConfig.titleRegex);
            if (titleMatch) {
                title = titleMatch[1].trim()
                    .replace(/&amp;/g, '&')
                    .replace(/&#x27;/g, "'")
                    .replace(/&quot;/g, '"');
            }
        }

        // Try to extract date from inner HTML if regex is provided
        let published_at = new Date().toISOString();
        if (scrapeConfig.dateRegex && match[2]) {
            const dateMatch = match[2].match(scrapeConfig.dateRegex);
            if (dateMatch) {
                try {
                    published_at = new Date(dateMatch[1].trim()).toISOString();
                } catch { /* keep default */ }
            }
        }

        articles.push({
            id: slug,
            title,
            url: fullUrl,
            source: name,
            published_at,
            image_url: "",
            news_site: name
        });
    }

    // Limit to MAX_NEWS_ARTICLES and enrich with OGS metadata
    const topArticles = articles.slice(0, MAX_NEWS_ARTICLES);

    return Promise.all(topArticles.map(async (item) => {
        try {
            const { result } = await ogs({ url: item.url, timeout: 4000 });
            if (result.ogTitle && item.title === `${name} News`) {
                let ogTitle = result.ogTitle;
                if (scrapeConfig.titleSuffix) {
                    ogTitle = ogTitle.replace(scrapeConfig.titleSuffix, '').trim();
                }
                item.title = ogTitle;
            }
            if (result.ogImage && result.ogImage.length > 0) {
                item.image_url = result.ogImage[0].url.replace(/&amp;/g, '&');
            }
            if (result.articlePublishedTime) {
                item.published_at = new Date(result.articlePublishedTime).toISOString();
            } else if ((result as any).ogDate) {
                item.published_at = new Date((result as any).ogDate).toISOString();
            }
        } catch (err) {
            console.error(`[SCRAPE] OGS fetch failed for ${name} article ${item.url}`, err);
        }
        return item;
    }));
}
