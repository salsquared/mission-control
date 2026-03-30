/**
 * Google News RSS Fetcher
 * Generates an RSS feed from Google News search results.
 * Used as a fallback for companies with blocked/paywalled sites.
 * Free to use — no API key required.
 */

import Parser from 'rss-parser';
import { MAX_NEWS_ARTICLES } from '../constants';
import type { NewsArticle } from './types';

const parser = new Parser();

/**
 * Fetch articles from Google News RSS for a given search query.
 * Constrains to last 7 days by default.
 */
export async function fetchGoogleNews(name: string, query: string): Promise<NewsArticle[]> {
    const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}+when:7d&hl=en-US&gl=US&ceid=US:en`;

    console.info(`[EXTERNAL API] Fetching Google News RSS for ${name}: ${rssUrl}`);

    const feed = await parser.parseURL(rssUrl);

    return feed.items.slice(0, MAX_NEWS_ARTICLES).map(item => ({
        id: item.guid || item.link || Math.random().toString(),
        title: item.title || `${name} News`,
        url: item.link || '',
        source: name,
        published_at: item.isoDate || item.pubDate || new Date().toISOString(),
        image_url: '', // Google News RSS typically doesn't include images
        news_site: name
    }));
}
