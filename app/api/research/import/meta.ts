import type { ApiMeta } from '@/lib/api-docs/meta';

export const apiMeta: ApiMeta = {
    purpose: 'Imports a research paper by ArXiv ID, DOI, or URL, fetching metadata from Semantic Scholar first and falling back to arXiv.',
    external: ['Semantic Scholar API', 'arXiv API'],
};
