import { googleNewsAdapter } from './factories';
import { TTL_LOW_VOLUME } from './custom-fetchers';

export default googleNewsAdapter({
    id: 'deepseek',
    name: 'Deepseek',
    view: 'ai',
    category: 'AI Model Developers',
    googleNewsQuery: 'Deepseek AI',
    ttlSeconds: TTL_LOW_VOLUME,
});
