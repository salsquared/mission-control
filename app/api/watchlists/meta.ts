import type { ApiMeta } from '@/lib/api-docs/meta';

export const apiMeta: ApiMeta = {
    purpose: "Lists and creates saved job-search watchlists; creation kicks off the first crawl in the background.",
    external: ['Job-board fetchers (varies)'],
    notes: "POST fire-and-forgets runWatchlist for the new row; mutations broadcast { model: 'Watchlist' }.",
};
