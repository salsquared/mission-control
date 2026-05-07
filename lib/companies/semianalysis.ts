import { googleNewsAdapter } from './factories';
import { TTL_LOW_VOLUME } from './custom-fetchers';

// Paywalled — can only surface titles/dates from Google News coverage
export default googleNewsAdapter({
    id: 'semianalysis',
    name: 'SemiAnalysis',
    view: 'ai',
    category: 'News Sources',
    googleNewsQuery: 'SemiAnalysis semiconductor',
    ttlSeconds: TTL_LOW_VOLUME,
});
