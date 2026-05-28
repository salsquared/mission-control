import type { ApiMeta } from '@/lib/api-docs/meta';

export const apiMeta: ApiMeta = {
    purpose: "Triggers an immediate crawl of a single watchlist, fetching fresh postings from its job-board source.",
    external: ['Job-board fetchers (varies)'],
    notes: "Runs the scheduler's runWatchlist job synchronously; broadcasts Watchlist + Posting SSE events.",
};
