import type { ApiMeta } from '@/lib/api-docs/meta';

export const apiMeta: ApiMeta = {
    purpose: 'Selects and fetches one historical research paper (3–30 years old) per topic per week, avoiding duplicates and enriching with citation counts.',
    external: ['arXiv API', 'Semantic Scholar API'],
    notes: 'The weekly pick is locked in the SelectedHistoricalPaper table for persistence across requests.',
};
