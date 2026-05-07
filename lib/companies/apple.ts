import { scrapeAdapter } from './factories';
import { TTL_LOW_VOLUME } from './custom-fetchers';

export default scrapeAdapter({
    id: 'apple',
    name: 'Apple ML',
    view: 'ai',
    category: 'Fabless',
    scrapeUrl: 'https://machinelearning.apple.com/',
    articleRegex: /href="(\/research\/[a-zA-Z0-9\/-]+)"/g,
    baseUrl: 'https://machinelearning.apple.com',
    minSlugLength: 15,
    ttlSeconds: TTL_LOW_VOLUME,
});
