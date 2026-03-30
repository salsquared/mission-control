/**
 * SNAPI (Spaceflight News API) Fetcher
 * Uses the title_contains parameter to pull third-party coverage
 * about a specific company from SpaceNews, NASASpaceflight, etc.
 */

import { MAX_NEWS_ARTICLES } from '../constants';
import type { NewsArticle } from './types';

const SNAPI_BASE = 'https://api.spaceflightnewsapi.net/v4/articles/';

/**
 * Fetch articles about a company from SNAPI using title_contains search.
 * Returns the most recent articles mentioning the company name.
 */
export async function fetchSNAPI(name: string, query: string): Promise<NewsArticle[]> {
    const url = `${SNAPI_BASE}?title_contains=${encodeURIComponent(query)}&limit=${MAX_NEWS_ARTICLES}&ordering=-published_at`;

    console.info(`[EXTERNAL API] Fetching from SNAPI for ${name}: ${url}`);

    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`Failed to fetch SNAPI articles for ${name}: ${res.status}`);
    }

    const data = await res.json();

    if (!data.results || !Array.isArray(data.results)) {
        return [];
    }

    return data.results.slice(0, MAX_NEWS_ARTICLES).map((item: any) => ({
        id: String(item.id),
        title: item.title || `${name} News`,
        url: item.url || '',
        source: name,
        published_at: item.published_at || new Date().toISOString(),
        image_url: item.image_url || '',
        news_site: item.news_site || name
    }));
}
