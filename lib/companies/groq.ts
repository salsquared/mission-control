import { customAdapter } from './factories';
import { fetchGroq, TTL_LOW_VOLUME } from './custom-fetchers';

// Custom fetcher scrapes both /blog and /newsroom, deduplicates, and merges by date.
export default customAdapter({
    id: 'groq',
    name: 'Groq',
    view: 'ai',
    category: 'AI Accelerators',
    fetcher: fetchGroq,
    upstreamHost: 'groq.com',
    ttlSeconds: TTL_LOW_VOLUME,
});
