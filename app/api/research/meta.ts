import type { ApiMeta } from '@/lib/api-docs/meta';

export const apiMeta: ApiMeta = {
    purpose: 'Fetches recent research papers for a topic (ai, crypto, space), using Hugging Face Daily Papers for the AI topic and arXiv otherwise, enriched with citation counts.',
    external: ['Hugging Face Daily Papers API', 'arXiv API', 'Semantic Scholar API'],
};
