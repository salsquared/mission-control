/**
 * RSS Feed Fetcher
 * Handles all companies that expose standard RSS/Atom feeds.
 */

import Parser from 'rss-parser';
import ogs from 'open-graph-scraper';
import { MAX_NEWS_ARTICLES } from '../constants';
import { ScraperBrokenError } from './errors';
import type { NewsArticle } from './types';
import { logExternalCall, hostOf } from '../external-fetch';
import { recordFetchOutcome } from '../fetcher-health/store';

const parser = new Parser();

/**
 * Fetch articles from a standard RSS/Atom feed URL,
 * then enrich with Open Graph images.
 */
export async function fetchRSS(name: string, rssUrl: string): Promise<NewsArticle[]> {
    // record: false — own the outcome below so one fetch = one row (a feed that
    // parses 0 items is `broken`, not `ok`; a parse/network throw is `error`).
    logExternalCall(rssUrl, 'GET', { record: false });
    const feed = await parser.parseURL(rssUrl).catch((e) => {
        recordFetchOutcome(hostOf(rssUrl), 'error');
        throw e;
    });

    if (feed.items.length === 0) {
        // Fetched the feed but it was empty — the scraper is broken.
        recordFetchOutcome(hostOf(rssUrl), 'broken');
        throw new ScraperBrokenError(name, 0);
    }

    // Parsed ≥1 item → working. Single `ok` outcome for this attempt.
    recordFetchOutcome(hostOf(rssUrl), 'ok');

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
                // Best-effort enrichment; mirror scrape-fetcher.ts noise trim.
                const reason = (err as any)?.result?.error
                    ?? (err instanceof Error ? err.message : 'unknown');
                console.warn(`[RSS] OGS skipped ${name} ${item.url}: ${reason}`);
            }
        }
        return item;
    }));

    return items;
}
