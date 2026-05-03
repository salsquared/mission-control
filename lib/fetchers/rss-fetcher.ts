/**
 * RSS Feed Fetcher
 * Handles all companies that expose standard RSS/Atom feeds.
 */

import Parser from 'rss-parser';
import ogs from 'open-graph-scraper';
import { MAX_NEWS_ARTICLES } from '../constants';
import { ScraperBrokenError } from './errors';
import type { NewsArticle } from './types';

const parser = new Parser();

/**
 * Fetch articles from a standard RSS/Atom feed URL,
 * then enrich with Open Graph images.
 */
export async function fetchRSS(name: string, rssUrl: string): Promise<NewsArticle[]> {
    console.info(`[EXTERNAL API] Fetching RSS from ${name}: ${rssUrl}`);
    const feed = await parser.parseURL(rssUrl);

    if (feed.items.length === 0) {
        throw new ScraperBrokenError(name, 0);
    }

    let items: NewsArticle[] = feed.items.slice(0, MAX_NEWS_ARTICLES).map(item => ({
        id: item.guid || item.link || Math.random().toString(),
        title: item.title || `${name} News`,
        url: item.link || "",
        source: name,
        published_at: item.isoDate || item.pubDate || new Date().toISOString(),
        image_url: "",
        news_site: name
    }));

    // Enrich with OG images (limit concurrency to first MAX_NEWS_ARTICLES)
    items = await Promise.all(items.map(async (item) => {
        if (item.url) {
            try {
                const { result } = await ogs({ url: item.url, timeout: 4000 });
                if (result.ogImage && result.ogImage.length > 0) {
                    item.image_url = result.ogImage[0].url.replace(/&amp;/g, '&');
                }
            } catch (err) {
                console.error(`[RSS] OGS fetch failed for ${name} article ${item.url}`, err);
            }
        }
        return item;
    }));

    return items;
}
