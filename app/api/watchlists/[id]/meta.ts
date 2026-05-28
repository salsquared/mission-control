import type { ApiMeta } from '@/lib/api-docs/meta';

export const apiMeta: ApiMeta = {
    purpose: "Updates (config, schedule, filters, track) or deletes a single saved job-search watchlist.",
    external: [],
    notes: "Mutations broadcast { model: 'Watchlist' }; a config PATCH clears directoryKey so user overrides stick.",
};
