import type { ApiMeta } from '@/lib/api-docs/meta';

export const apiMeta: ApiMeta = {
    purpose: 'Fetches the latest news articles for a registered company, dispatching to its declared fetch strategy (RSS, scrape, Spaceflight News API, Google News, vendor JSON API, or a custom inline fetcher), with a legacy generic-RSS path via ?rss=.',
    external: ['Company RSS feeds', 'Spaceflight News API', 'Google News RSS', 'vendor JSON APIs', 'Microlink'],
    notes: 'Upstream host is derived per-request from the ?company= (or ?rss=) value for Fetcher Health grouping.',
};
