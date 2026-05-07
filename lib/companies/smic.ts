import { googleNewsAdapter } from './factories';
import { TTL_LOW_VOLUME } from './custom-fetchers';

// TODO: Add translation layer
export default googleNewsAdapter({
    id: 'smic',
    name: 'SMIC',
    view: 'ai',
    category: 'Foundries',
    googleNewsQuery: 'SMIC semiconductor',
    ttlSeconds: TTL_LOW_VOLUME,
});
