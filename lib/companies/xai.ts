import { scrapeAdapter } from './factories';
import { TTL_LOW_VOLUME } from './custom-fetchers';

export default scrapeAdapter({
    id: 'xai',
    name: 'xAI',
    view: 'ai',
    category: 'AI Model Developers',
    scrapeUrl: 'https://x.ai/news',
    articleRegex: /href="(\/news\/[a-zA-Z0-9-]+)"/g,
    baseUrl: 'https://x.ai',
    minSlugLength: 10,
    ttlSeconds: TTL_LOW_VOLUME,
});
