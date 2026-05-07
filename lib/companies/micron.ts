import { googleNewsAdapter } from './factories';
import { TTL_LOW_VOLUME } from './custom-fetchers';

export default googleNewsAdapter({
    id: 'micron',
    name: 'Micron',
    view: 'ai',
    category: 'Foundries',
    googleNewsQuery: 'Micron Technology',
    ttlSeconds: TTL_LOW_VOLUME,
});
