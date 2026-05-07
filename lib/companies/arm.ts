import { scrapeAdapter } from './factories';
import { TTL_LOW_VOLUME } from './custom-fetchers';

export default scrapeAdapter({
    id: 'arm',
    name: 'ARM',
    view: 'ai',
    category: 'IP/Architecture',
    scrapeUrl: 'https://newsroom.arm.com/',
    articleRegex: /href="(\/news\/[a-zA-Z0-9\/-]+)"/g,
    baseUrl: 'https://newsroom.arm.com',
    minSlugLength: 10,
    ttlSeconds: TTL_LOW_VOLUME,
});
