import { googleNewsAdapter } from './factories';
import { TTL_LOW_VOLUME } from './custom-fetchers';

export default googleNewsAdapter({
    id: 'tsmc',
    name: 'TSMC',
    view: 'ai',
    category: 'Foundries',
    googleNewsQuery: 'TSMC semiconductor',
    ttlSeconds: TTL_LOW_VOLUME,
});
