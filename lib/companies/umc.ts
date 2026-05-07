import { googleNewsAdapter } from './factories';
import { TTL_VERY_LOW } from './custom-fetchers';

export default googleNewsAdapter({
    id: 'umc',
    name: 'UMC',
    view: 'ai',
    category: 'Foundries',
    googleNewsQuery: 'UMC semiconductor foundry',
    ttlSeconds: TTL_VERY_LOW,
});
