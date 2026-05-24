/**
 * SNAPI (Spaceflight News API) Fetcher
 * Uses the title_contains parameter to pull third-party coverage
 * about a specific company from SpaceNews, NASASpaceflight, etc.
 */

import { MAX_NEWS_ARTICLES } from '../constants';
import type { NewsArticle } from './types';
import { loggedFetch } from '../external-fetch';

const SNAPI_BASE = 'https://api.spaceflightnewsapi.net/v4/articles/';

// ~17 SpaceView companies use SNAPI, so a cold-cache SpaceView open fires
// that many parallel requests and SNAPI 429s the tail. Serialize through a
// module-level promise chain with a 500ms inter-request gap (~2 req/s, well
// under SNAPI's tolerance) so the burst trickles through instead of getting
// rate-limited. Stashed on globalThis so HMR + repeated module imports
// share one queue.
const SNAPI_MIN_GAP_MS = 500;
const QUEUE_KEY = '__mcSnapiQueue';
const g = globalThis as unknown as { [QUEUE_KEY]?: Promise<unknown> };
function snapiQueue(): Promise<unknown> { return g[QUEUE_KEY] ?? Promise.resolve(); }
function setSnapiQueue(p: Promise<unknown>) { g[QUEUE_KEY] = p; }

/**
 * Fetch articles about a company from SNAPI using title_contains search.
 * Returns the most recent articles mentioning the company name.
 */
export async function fetchSNAPI(name: string, query: string): Promise<NewsArticle[]> {
    const url = `${SNAPI_BASE}?title_contains=${encodeURIComponent(query)}&limit=${MAX_NEWS_ARTICLES}&ordering=-published_at`;

    const result = snapiQueue().then(async () => {
        const res = await loggedFetch(url);
        if (!res.ok) {
            throw new Error(`Failed to fetch SNAPI articles for ${name}: ${res.status}`);
        }
        return res.json();
    });

    // Advance the queue: wait for this call to settle (success or failure),
    // then enforce the inter-request gap before the next caller proceeds.
    setSnapiQueue(result.catch(() => {}).then(() => new Promise((r) => setTimeout(r, SNAPI_MIN_GAP_MS))));

    const data = await result;

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
