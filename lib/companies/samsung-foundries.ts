import { googleNewsAdapter } from './factories';
import { TTL_LOW_VOLUME } from './custom-fetchers';

export default googleNewsAdapter({
    id: 'samsung-foundries',
    name: 'Samsung Foundries',
    view: 'ai',
    category: 'Foundries',
    googleNewsQuery: 'Samsung Foundry semiconductor',
    ttlSeconds: TTL_LOW_VOLUME,
});
