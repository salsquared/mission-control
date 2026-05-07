import { googleNewsAdapter } from './factories';
import { TTL_LOW_VOLUME } from './custom-fetchers';

// TODO: Add translation layer
export default googleNewsAdapter({
    id: 'bytedance',
    name: 'ByteDance',
    view: 'ai',
    category: 'AI Model Developers',
    googleNewsQuery: 'ByteDance AI Seed',
    ttlSeconds: TTL_LOW_VOLUME,
});
