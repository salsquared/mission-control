/**
 * Company Feed Registry
 * 
 * Central configuration for all company news/blog feeds.
 * Each entry defines the company metadata and ingestion strategy.
 * The route handler dispatches to the appropriate fetcher based on the strategy.
 * 
 * Adding a new RSS company = ~5 lines of config. No code changes needed.
 */

import { MAX_NEWS_ARTICLES } from './constants';
import type { CompanyFeedConfig, NewsArticle } from './fetchers/types';

// ─── TTL Presets ───
const TTL_STANDARD = 3600;         // 1 hour — default for active sources
const TTL_LOW_VOLUME = 86400;      // 24 hours — for companies that post weekly
const TTL_VERY_LOW = 604800;       // 7 days — for small startups posting monthly

// ─── Custom Fetchers (for sources with unique API shapes) ───

/** SpaceX has a custom JSON API with a unique response shape */
async function fetchSpaceX(): Promise<NewsArticle[]> {
    console.info('[EXTERNAL API] Fetching from SpaceX API...');
    const res = await fetch('https://content.spacex.com/api/spacex-website/updates');
    if (!res.ok) throw new Error(`Failed to fetch SpaceX news: ${res.status}`);
    const data = await res.json();

    return data.slice(0, MAX_NEWS_ARTICLES).map((item: any) => ({
        id: item.id || item.updateId,
        title: item.title || "SpaceX News",
        url: `https://www.spacex.com/updates/#${item.updateId}`,
        source: 'SpaceX',
        published_at: item.date ? new Date(item.date).toISOString() : new Date().toISOString(),
        image_url: item.image?.small || item.image?.medium || item.image?.thumbnail || "",
        news_site: 'SpaceX'
    }));
}

/** OpenAI RSS + Microlink for images (bypasses Cloudflare which blocks OGS) */
async function fetchOpenAI(): Promise<NewsArticle[]> {
    const Parser = (await import('rss-parser')).default;
    const parser = new Parser();
    console.info('[EXTERNAL API] Fetching RSS from OpenAI...');
    const feed = await parser.parseURL('https://openai.com/news/rss.xml');
    const items = feed.items.slice(0, MAX_NEWS_ARTICLES);

    return Promise.all(items.map(async (item, i) => {
        let image_url = "";
        if (i < 4 && item.link) {
            try {
                console.info(`[EXTERNAL API] Fetching image via Microlink API...`);
                const res = await fetch(`https://api.microlink.io?url=${encodeURIComponent(item.link)}`);
                if (res.ok) {
                    const data = await res.json();
                    image_url = data?.data?.image?.url || "";
                }
            } catch (err) {
                console.error("Microlink error for OpenAI image extraction", err);
            }
        }
        return {
            id: item.guid || item.link || Math.random().toString(),
            title: item.title || "OpenAI News",
            url: item.link || `https://openai.com`,
            source: 'OpenAI',
            published_at: item.isoDate || item.pubDate || new Date().toISOString(),
            image_url,
            news_site: 'OpenAI'
        };
    }));
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  REGISTRY
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export const COMPANY_REGISTRY: CompanyFeedConfig[] = [

    // ════════════════════════════════════════════════════════
    //  SPACE VIEW — Prime Contractors / Launch Providers
    // ════════════════════════════════════════════════════════

    {
        id: 'spacex',
        name: 'SpaceX',
        strategy: 'custom',
        view: 'space',
        category: 'Prime Contractors',
        customFetcher: fetchSpaceX,
    },
    {
        id: 'rocketlab',
        name: 'Rocket Lab',
        strategy: 'scrape',
        view: 'space',
        category: 'Prime Contractors',
        scrapeUrl: 'https://www.rocketlabusa.com/updates/',
        scrapeConfig: {
            articleRegex: /href="(\/updates\/[^"]+)"/g,
            baseUrl: 'https://www.rocketlabusa.com',
            titleSuffix: ' | Rocket Lab',
            minSlugLength: 15,
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        },
    },
    {
        id: 'blue-origin',
        name: 'Blue Origin',
        strategy: 'snapi',
        view: 'space',
        category: 'Prime Contractors',
        snapiQuery: 'Blue Origin',
    },
    {
        id: 'northrop-grumman',
        name: 'Northrop Grumman',
        strategy: 'snapi',
        view: 'space',
        category: 'Prime Contractors',
        snapiQuery: 'Northrop Grumman',
    },
    {
        id: 'boeing',
        name: 'Boeing',
        strategy: 'snapi',
        view: 'space',
        category: 'Prime Contractors',
        snapiQuery: 'Boeing',
        // Note: Boeing does have a MediaRoom RSS but it covers ALL divisions not just space.
        // SNAPI filters to space-relevant coverage automatically.
    },
    {
        id: 'lockheed-martin',
        name: 'Lockheed Martin',
        strategy: 'snapi',
        view: 'space',
        category: 'Prime Contractors',
        snapiQuery: 'Lockheed Martin',
        // Note: LM has RSS at lockheedmartin.com/news/rss.html but covers all divisions.
        // SNAPI filters to space-relevant coverage. Could swap to RSS with keyword filtering later.
    },
    {
        id: 'arianegroup',
        name: 'ArianeGroup',
        strategy: 'snapi',
        view: 'space',
        category: 'Prime Contractors',
        snapiQuery: 'Ariane',
    },
    {
        id: 'ula',
        name: 'ULA',
        strategy: 'snapi',
        view: 'space',
        category: 'Prime Contractors',
        snapiQuery: 'ULA',
    },

    // ════════════════════════════════════════════════════════
    //  SPACE VIEW — Upstart Launch Providers
    // ════════════════════════════════════════════════════════

    {
        id: 'relativity',
        name: 'Relativity Space',
        strategy: 'snapi',
        view: 'space',
        category: 'Upstart Launch Providers',
        snapiQuery: 'Relativity Space',
        ttlSeconds: TTL_LOW_VOLUME,
    },
    {
        id: 'firefly',
        name: 'Firefly Aerospace',
        strategy: 'snapi',
        view: 'space',
        category: 'Upstart Launch Providers',
        snapiQuery: 'Firefly Aerospace',
        ttlSeconds: TTL_LOW_VOLUME,
    },
    {
        id: 'stoke',
        name: 'Stoke Space',
        strategy: 'snapi',
        view: 'space',
        category: 'Upstart Launch Providers',
        snapiQuery: 'Stoke Space',
        ttlSeconds: TTL_LOW_VOLUME,
    },
    {
        id: 'rfa',
        name: 'Rocket Factory Augsburg',
        strategy: 'snapi',
        view: 'space',
        category: 'Upstart Launch Providers',
        snapiQuery: 'Rocket Factory',
        ttlSeconds: TTL_LOW_VOLUME,
    },

    // ════════════════════════════════════════════════════════
    //  SPACE VIEW — Space Hardware / Component Manufacturers
    // ════════════════════════════════════════════════════════

    {
        id: 'redwire',
        name: 'Redwire',
        strategy: 'rss',
        view: 'space',
        category: 'Space Hardware',
        rssUrl: 'https://rdw.com/feed/',
    },
    {
        id: 'aerojet-rocketdyne',
        name: 'Aerojet Rocketdyne',
        strategy: 'snapi',
        view: 'space',
        category: 'Space Hardware',
        snapiQuery: 'Rocketdyne',
        ttlSeconds: TTL_LOW_VOLUME,
    },
    {
        id: 'ursa-major',
        name: 'Ursa Major',
        strategy: 'snapi',
        view: 'space',
        category: 'Space Hardware',
        snapiQuery: 'Ursa Major',
        ttlSeconds: TTL_VERY_LOW,
    },
    {
        id: 'xona',
        name: 'Xona Space Systems',
        strategy: 'snapi',
        view: 'space',
        category: 'Space Hardware',
        snapiQuery: 'Xona',
        ttlSeconds: TTL_VERY_LOW,
    },
    {
        id: 'blue-canyon',
        name: 'Blue Canyon Technologies',
        strategy: 'snapi',
        view: 'space',
        category: 'Space Hardware',
        snapiQuery: 'Blue Canyon',
        ttlSeconds: TTL_VERY_LOW,
    },
    {
        id: 'hadrian',
        name: 'Hadrian',
        strategy: 'google-news',
        view: 'space',
        category: 'Space Hardware',
        googleNewsQuery: 'Hadrian aerospace manufacturing',
        ttlSeconds: TTL_VERY_LOW,
    },
    {
        id: 'apex',
        name: 'Apex Space',
        strategy: 'snapi',
        view: 'space',
        category: 'Space Hardware',
        snapiQuery: 'Apex Space',
        ttlSeconds: TTL_VERY_LOW,
    },

    // ════════════════════════════════════════════════════════
    //  SPACE VIEW — Government Space Agencies
    // ════════════════════════════════════════════════════════

    {
        id: 'nasa',
        name: 'NASA',
        strategy: 'rss',
        view: 'space',
        category: 'Government Agencies',
        rssUrl: 'https://www.nasa.gov/rss/dyn/breaking_news.rss',
    },
    {
        id: 'esa',
        name: 'ESA',
        strategy: 'rss',
        view: 'space',
        category: 'Government Agencies',
        rssUrl: 'https://www.esa.int/rssfeed/Our_Activities/Space_Science',
    },
    {
        id: 'jaxa',
        name: 'JAXA',
        strategy: 'snapi',
        view: 'space',
        category: 'Government Agencies',
        snapiQuery: 'JAXA',
        // JAXA English press page exists but no RSS. SNAPI coverage is decent.
    },
    {
        id: 'cnsa',
        name: 'CNSA',
        strategy: 'google-news',
        view: 'space',
        category: 'Government Agencies',
        googleNewsQuery: 'CNSA China space',
        ttlSeconds: TTL_LOW_VOLUME,
        // TODO: Add translation layer
    },
    {
        id: 'roscosmos',
        name: 'Roscosmos',
        strategy: 'google-news',
        view: 'space',
        category: 'Government Agencies',
        googleNewsQuery: 'Roscosmos',
        ttlSeconds: TTL_LOW_VOLUME,
        // TODO: Add translation layer
    },
    {
        id: 'isro',
        name: 'ISRO',
        strategy: 'snapi',
        view: 'space',
        category: 'Government Agencies',
        snapiQuery: 'ISRO',
    },
    {
        id: 'csa',
        name: 'CSA',
        strategy: 'snapi',
        view: 'space',
        category: 'Government Agencies',
        snapiQuery: 'Canadian Space Agency',
        // CSA has RSS but SNAPI also covers them well with space-specific content.
    },

    // ════════════════════════════════════════════════════════
    //  AI VIEW — AI Software / Model Developers
    // ════════════════════════════════════════════════════════

    {
        id: 'openai',
        name: 'OpenAI',
        strategy: 'custom',
        view: 'ai',
        category: 'AI Model Developers',
        customFetcher: fetchOpenAI,
    },
    {
        id: 'anthropic',
        name: 'Anthropic',
        strategy: 'scrape',
        view: 'ai',
        category: 'AI Model Developers',
        scrapeUrl: 'https://www.anthropic.com/news',
        scrapeConfig: {
            articleRegex: /<a[^>]*href="\/news\/([^"]+)"[^>]*>([\s\S]*?)<\/a>/g,
            baseUrl: 'https://anthropic.com/news',
            titleRegex: /<span[^>]*class="[^"]*title[^"]*"[^>]*>([\s\S]*?)<\/span>/,
            dateRegex: /<time[^>]*>([^<]+)<\/time>/,
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
    },
    {
        id: 'deepmind',
        name: 'Google DeepMind',
        strategy: 'rss',
        view: 'ai',
        category: 'AI Model Developers',
        rssUrl: 'https://deepmind.google/blog/rss.xml',
    },
    {
        id: 'meta',
        name: 'Meta AI',
        strategy: 'scrape',
        view: 'ai',
        category: 'AI Model Developers',
        scrapeUrl: 'https://ai.meta.com/blog/',
        scrapeConfig: {
            articleRegex: /href="(?:https:\/\/ai\.meta\.com)?(\/blog\/[a-zA-Z0-9-]+\/?)"/g,
            baseUrl: 'https://ai.meta.com',
            titleSuffix: ' - AI at Meta',
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
    },
    {
        id: 'microsoft',
        name: 'Microsoft AI',
        strategy: 'rss',
        view: 'ai',
        category: 'AI Model Developers',
        rssUrl: 'https://blogs.microsoft.com/ai/feed/',
    },
    {
        id: 'xai',
        name: 'xAI',
        strategy: 'scrape',
        view: 'ai',
        category: 'AI Model Developers',
        scrapeUrl: 'https://x.ai/news',
        scrapeConfig: {
            articleRegex: /href="(\/news\/[a-zA-Z0-9-]+)"/g,
            baseUrl: 'https://x.ai',
            minSlugLength: 10,
        },
        ttlSeconds: TTL_LOW_VOLUME,
    },
    {
        id: 'mistral',
        name: 'Mistral',
        strategy: 'scrape',
        view: 'ai',
        category: 'AI Model Developers',
        scrapeUrl: 'https://mistral.ai/news/',
        scrapeConfig: {
            articleRegex: /href="(\/news\/[a-zA-Z0-9-]+)"/g,
            baseUrl: 'https://mistral.ai',
            minSlugLength: 10,
        },
    },
    {
        id: 'huggingface',
        name: 'Hugging Face',
        strategy: 'rss',
        view: 'ai',
        category: 'AI Model Developers',
        rssUrl: 'https://huggingface.co/blog/feed.xml',
    },
    {
        id: 'deepseek',
        name: 'Deepseek',
        strategy: 'google-news',
        view: 'ai',
        category: 'AI Model Developers',
        googleNewsQuery: 'Deepseek AI',
        ttlSeconds: TTL_LOW_VOLUME,
    },
    {
        id: 'baidu',
        name: 'Baidu AI',
        strategy: 'google-news',
        view: 'ai',
        category: 'AI Model Developers',
        googleNewsQuery: 'Baidu AI',
        ttlSeconds: TTL_LOW_VOLUME,
        // TODO: Add translation layer
    },
    {
        id: 'bytedance',
        name: 'ByteDance',
        strategy: 'google-news',
        view: 'ai',
        category: 'AI Model Developers',
        googleNewsQuery: 'ByteDance AI Seed',
        ttlSeconds: TTL_LOW_VOLUME,
        // TODO: Add translation layer
    },

    // ════════════════════════════════════════════════════════
    //  AI VIEW — Computation: Fabless
    // ════════════════════════════════════════════════════════

    {
        id: 'nvidia',
        name: 'Nvidia AI',
        strategy: 'rss',
        view: 'ai',
        category: 'Fabless',
        rssUrl: 'https://blogs.nvidia.com/feed/',
    },
    {
        id: 'amd',
        name: 'AMD',
        strategy: 'rss',
        view: 'ai',
        category: 'Fabless',
        rssUrl: 'https://ir.amd.com/rss/PressRelease',
    },
    {
        id: 'intel',
        name: 'Intel',
        strategy: 'rss',
        view: 'ai',
        category: 'Fabless',
        rssUrl: 'https://newsroom.intel.com/feed',
    },
    {
        id: 'qualcomm',
        name: 'Qualcomm',
        strategy: 'scrape',
        view: 'ai',
        category: 'Fabless',
        scrapeUrl: 'https://www.qualcomm.com/news/onq',
        scrapeConfig: {
            articleRegex: /href="(\/news\/onq\/[a-zA-Z0-9\/-]+)"/g,
            baseUrl: 'https://www.qualcomm.com',
            minSlugLength: 15,
        },
        ttlSeconds: TTL_LOW_VOLUME,
    },
    {
        id: 'broadcom',
        name: 'Broadcom',
        strategy: 'google-news',
        view: 'ai',
        category: 'Fabless',
        googleNewsQuery: 'Broadcom semiconductor',
        ttlSeconds: TTL_LOW_VOLUME,
    },
    {
        id: 'apple',
        name: 'Apple ML',
        strategy: 'scrape',
        view: 'ai',
        category: 'Fabless',
        scrapeUrl: 'https://machinelearning.apple.com/',
        scrapeConfig: {
            articleRegex: /href="(\/research\/[a-zA-Z0-9\/-]+)"/g,
            baseUrl: 'https://machinelearning.apple.com',
            minSlugLength: 15,
        },
        ttlSeconds: TTL_LOW_VOLUME,
    },
    {
        id: 'google-ai',
        name: 'Google AI',
        strategy: 'rss',
        view: 'ai',
        category: 'Fabless',
        rssUrl: 'https://research.google/blog/feed/',
        // Separate from DeepMind — this is Google Research blog
    },

    // ════════════════════════════════════════════════════════
    //  AI VIEW — Computation: AI Accelerators
    // ════════════════════════════════════════════════════════

    {
        id: 'groq',
        name: 'Groq',
        strategy: 'scrape',
        view: 'ai',
        category: 'AI Accelerators',
        scrapeUrl: 'https://groq.com/news/',
        scrapeConfig: {
            articleRegex: /href="(https:\/\/groq\.com\/[a-zA-Z0-9\/-]+)"/g,
            baseUrl: 'https://groq.com',
            minSlugLength: 20,
        },
        ttlSeconds: TTL_LOW_VOLUME,
    },
    {
        id: 'cerebras',
        name: 'Cerebras',
        strategy: 'scrape',
        view: 'ai',
        category: 'AI Accelerators',
        scrapeUrl: 'https://cerebras.ai/blog',
        scrapeConfig: {
            articleRegex: /href="(\/blog\/[a-zA-Z0-9\/-]+)"/g,
            baseUrl: 'https://cerebras.ai',
            minSlugLength: 10,
        },
        ttlSeconds: TTL_LOW_VOLUME,
    },

    // ════════════════════════════════════════════════════════
    //  AI VIEW — Computation: IP/Architecture
    // ════════════════════════════════════════════════════════

    {
        id: 'arm',
        name: 'ARM',
        strategy: 'scrape',
        view: 'ai',
        category: 'IP/Architecture',
        scrapeUrl: 'https://newsroom.arm.com/',
        scrapeConfig: {
            articleRegex: /href="(\/news\/[a-zA-Z0-9\/-]+)"/g,
            baseUrl: 'https://newsroom.arm.com',
            minSlugLength: 10,
        },
        ttlSeconds: TTL_LOW_VOLUME,
    },

    // ════════════════════════════════════════════════════════
    //  AI VIEW — Computation: Foundries
    // ════════════════════════════════════════════════════════

    {
        id: 'samsung-foundries',
        name: 'Samsung Foundries',
        strategy: 'google-news',
        view: 'ai',
        category: 'Foundries',
        googleNewsQuery: 'Samsung Foundry semiconductor',
        ttlSeconds: TTL_LOW_VOLUME,
    },
    {
        id: 'tsmc',
        name: 'TSMC',
        strategy: 'google-news',
        view: 'ai',
        category: 'Foundries',
        googleNewsQuery: 'TSMC semiconductor',
        ttlSeconds: TTL_LOW_VOLUME,
    },
    {
        id: 'globalfoundries',
        name: 'GlobalFoundries',
        strategy: 'google-news',
        view: 'ai',
        category: 'Foundries',
        googleNewsQuery: 'GlobalFoundries semiconductor',
        ttlSeconds: TTL_LOW_VOLUME,
    },
    {
        id: 'umc',
        name: 'UMC',
        strategy: 'google-news',
        view: 'ai',
        category: 'Foundries',
        googleNewsQuery: 'UMC semiconductor foundry',
        ttlSeconds: TTL_VERY_LOW,
    },
    {
        id: 'smic',
        name: 'SMIC',
        strategy: 'google-news',
        view: 'ai',
        category: 'Foundries',
        googleNewsQuery: 'SMIC semiconductor',
        ttlSeconds: TTL_LOW_VOLUME,
        // TODO: Add translation layer
    },
    {
        id: 'intel-foundry',
        name: 'Intel Foundry',
        strategy: 'rss',
        view: 'ai',
        category: 'Foundries',
        rssUrl: 'https://newsroom.intel.com/feed',
        // Re-uses Intel's main RSS. Could add keyword filtering later.
    },
    {
        id: 'micron',
        name: 'Micron',
        strategy: 'google-news',
        view: 'ai',
        category: 'Foundries',
        googleNewsQuery: 'Micron Technology',
        ttlSeconds: TTL_LOW_VOLUME,
    },

    // ════════════════════════════════════════════════════════
    //  AI VIEW — AI/Computation News Sources
    // ════════════════════════════════════════════════════════

    {
        id: 'semianalysis',
        name: 'SemiAnalysis',
        strategy: 'google-news',
        view: 'ai',
        category: 'News Sources',
        googleNewsQuery: 'SemiAnalysis semiconductor',
        ttlSeconds: TTL_LOW_VOLUME,
        // Paywalled — can only surface titles/dates from Google News coverage
    },
];


// ─── Lookup Helpers ───

/** Get a company config by its ID */
export function getCompanyConfig(id: string): CompanyFeedConfig | undefined {
    return COMPANY_REGISTRY.find(c => c.id === id || c.id === id.toLowerCase());
}

/** Get all companies for a specific view */
export function getCompaniesByView(view: 'space' | 'ai'): CompanyFeedConfig[] {
    return COMPANY_REGISTRY.filter(c => c.view === view || c.view === 'both');
}

/** Get all companies for a specific category */
export function getCompaniesByCategory(category: string): CompanyFeedConfig[] {
    return COMPANY_REGISTRY.filter(c => c.category === category);
}

/** Get all unique categories for a view */
export function getCategoriesForView(view: 'space' | 'ai'): string[] {
    const companies = getCompaniesByView(view);
    return [...new Set(companies.map(c => c.category))];
}

/** Get alias mappings for backward compatibility */
const ALIASES: Record<string, string> = {
    'rocket-lab': 'rocketlab',
    'google': 'deepmind',
};

export function resolveCompanyId(input: string): string {
    const lower = input.toLowerCase();
    return ALIASES[lower] || lower;
}
