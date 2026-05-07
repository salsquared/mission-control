import { googleNewsAdapter } from './factories';
import { TTL_LOW_VOLUME } from './custom-fetchers';

export default googleNewsAdapter({
    id: 'globalfoundries',
    name: 'GlobalFoundries',
    view: 'ai',
    category: 'Foundries',
    googleNewsQuery: 'GlobalFoundries semiconductor',
    ttlSeconds: TTL_LOW_VOLUME,
});
