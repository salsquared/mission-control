import { googleNewsAdapter } from './factories';
import { TTL_LOW_VOLUME } from './custom-fetchers';

// TODO: Add translation layer
export default googleNewsAdapter({
    id: 'baidu',
    name: 'Baidu AI',
    view: 'ai',
    category: 'AI Model Developers',
    googleNewsQuery: 'Baidu AI',
    ttlSeconds: TTL_LOW_VOLUME,
});
