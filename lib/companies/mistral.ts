import { scrapeAdapter } from './factories';

export default scrapeAdapter({
    id: 'mistral',
    name: 'Mistral',
    view: 'ai',
    category: 'AI Model Developers',
    scrapeUrl: 'https://mistral.ai/news/',
    articleRegex: /href="(\/news\/[a-zA-Z0-9-]+)"/g,
    baseUrl: 'https://mistral.ai',
    minSlugLength: 10,
});
