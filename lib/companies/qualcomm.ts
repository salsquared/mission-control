import { scrapeAdapter } from './factories';
import { TTL_LOW_VOLUME } from './custom-fetchers';

export default scrapeAdapter({
    id: 'qualcomm',
    name: 'Qualcomm',
    view: 'ai',
    category: 'Fabless',
    scrapeUrl: 'https://www.qualcomm.com/news/onq',
    articleRegex: /href="(\/news\/onq\/[a-zA-Z0-9\/-]+)"/g,
    baseUrl: 'https://www.qualcomm.com',
    minSlugLength: 15,
    ttlSeconds: TTL_LOW_VOLUME,
});
