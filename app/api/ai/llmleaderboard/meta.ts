import type { ApiMeta } from '@/lib/api-docs/meta';

export const apiMeta: ApiMeta = {
    purpose: 'Scrapes and parses the LM Arena leaderboard for a given category (default "text"), returning the top 50 models sorted by Elo score.',
    external: ['LM Arena'],
    notes: 'Dedupes repeated model rows in the scraped table, keeping the highest-Elo occurrence per id.',
};
