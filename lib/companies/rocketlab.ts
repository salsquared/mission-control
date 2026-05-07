import { scrapeAdapter } from './factories';

export default scrapeAdapter({
    id: 'rocketlab',
    name: 'Rocket Lab',
    view: 'space',
    category: 'Prime Contractors',
    scrapeUrl: 'https://www.rocketlabusa.com/updates/',
    articleRegex: /href="(\/updates\/[^"]+)"/g,
    baseUrl: 'https://www.rocketlabusa.com',
    titleSuffix: ' | Rocket Lab',
    minSlugLength: 15,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
});
