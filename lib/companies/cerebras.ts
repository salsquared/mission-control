import { customAdapter } from './factories';
import { fetchCerebras, TTL_LOW_VOLUME } from './custom-fetchers';

export default customAdapter({
    id: 'cerebras',
    name: 'Cerebras',
    view: 'ai',
    category: 'AI Accelerators',
    fetcher: fetchCerebras,
    upstreamHost: 'cerebras.ai',
    ttlSeconds: TTL_LOW_VOLUME,
});
