import { googleNewsAdapter } from './factories';
import { TTL_LOW_VOLUME } from './custom-fetchers';

export default googleNewsAdapter({
    id: 'broadcom',
    name: 'Broadcom',
    view: 'ai',
    category: 'Fabless',
    googleNewsQuery: 'Broadcom semiconductor',
    ttlSeconds: TTL_LOW_VOLUME,
});
