import type { ApiMeta } from '@/lib/api-docs/meta';

export const apiMeta: ApiMeta = {
    purpose: 'Picks and features one review or survey paper from the last 365 days per topic per week, enriching with citation counts.',
    external: ['arXiv API', 'Semantic Scholar API'],
    notes: 'The weekly pick is locked in the SelectedReviewPaper table for persistence across requests.',
};
