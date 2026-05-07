import { customAdapter } from './factories';
import { fetchMetaAI } from './custom-fetchers';

// Custom fetcher scrapes ai.meta.com/blog/ listing page for dates, titles, and images.
// Individual posts lack OG date metadata, so dates are extracted from the listing.
export default customAdapter({
    id: 'meta',
    name: 'Meta AI',
    view: 'ai',
    category: 'AI Model Developers',
    fetcher: fetchMetaAI,
    upstreamHost: 'ai.meta.com',
});
