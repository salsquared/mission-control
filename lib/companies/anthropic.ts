import { scrapeAdapter } from './factories';

export default scrapeAdapter({
    id: 'anthropic',
    name: 'Anthropic',
    view: 'ai',
    category: 'AI Model Developers',
    scrapeUrl: 'https://www.anthropic.com/news',
    articleRegex: /<a[^>]*href="\/news\/([^"]+)"[^>]*>([\s\S]*?)<\/a>/g,
    baseUrl: 'https://anthropic.com/news',
    titleRegex: /<span[^>]*class="[^"]*title[^"]*"[^>]*>([\s\S]*?)<\/span>/,
    dateRegex: /<time[^>]*>([^<]+)<\/time>/,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
});
