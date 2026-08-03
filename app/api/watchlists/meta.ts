import type { ApiMeta } from '@/lib/api-docs/meta';

export const apiMeta: ApiMeta = {
    purpose: "Lists and creates saved job-search watchlists; creation kicks off the first crawl in the background unless the caller is out of daily AI credit.",
    external: ['Job-board fetchers (varies)', 'Google Gemini (via the initial crawl)'],
    notes: "POST fire-and-forgets runWatchlist for the new row, but only after consumeAiCredit grants — that crawl classifies employment types through Gemini. Over quota the row is still created and the crawl is skipped (the scheduler picks it up on its normal cadence); the 200 reports which happened via `initialCrawl`. Mutations broadcast { model: 'Watchlist' }.",
};
