import { googleNewsAdapter } from './factories';
import { TTL_LOW_VOLUME } from './custom-fetchers';

// x.ai sits behind a Cloudflare bot-detection layer that 403s every
// scrape attempt — full browser User-Agent + Accept-* headers didn't
// move it, so we'd need a headless browser or paid scraping service to
// scrape directly. Google News is the canonical fallback (already used
// by Baidu, ByteDance, etc.).
export default googleNewsAdapter({
    id: 'xai',
    name: 'xAI',
    view: 'ai',
    category: 'AI Model Developers',
    googleNewsQuery: 'xAI Grok',
    ttlSeconds: TTL_LOW_VOLUME,
});
