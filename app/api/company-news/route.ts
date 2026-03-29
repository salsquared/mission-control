import { NextResponse } from 'next/server';
import { withCache } from '../../../lib/cache';
import Parser from 'rss-parser';
import ogs from 'open-graph-scraper';
import { MAX_NEWS_ARTICLES } from '../../../lib/constants';

const parser = new Parser();

async function fetchOpenAI() {
    console.info('[EXTERNAL API] Fetching RSS from OpenAI...');
    const feed = await parser.parseURL('https://openai.com/news/rss.xml');

    const items = feed.items.slice(0, MAX_NEWS_ARTICLES);

    return Promise.all(items.map(async (item, i) => {
        let image_url = "";
        // Try getting image via microlink API for the first 4 items to save on rate limits, as it bypasses Cloudflare
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
            published_at: item.isoDate || item.pubDate,
            image_url,
            news_site: 'OpenAI'
        };
    }));
}

async function fetchAnthropic() {
    console.info('[EXTERNAL API] Fetching from Anthropic News...');
    const res = await fetch('https://www.anthropic.com/news', {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
    });

    if (!res.ok) {
        throw new Error(`Failed to fetch Anthropic news: ${res.status}`);
    }
    const html = await res.text();

    // Very basic regex to pull articles from their site since they don't have standard RSS
    const articleRegex = /<a[^>]*href="\/news\/([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    let match;
    const articles: { id: string, title: string, url: string, source: string, published_at: string, image_url: string, news_site: string }[] = [];

    while ((match = articleRegex.exec(html)) !== null) {
        const slug = match[1];
        const innerHtml = match[2];

        // Extract title
        const titleMatch = innerHtml.match(/<span[^>]*class="[^"]*title[^"]*"[^>]*>([\s\S]*?)<\/span>/);
        const title = titleMatch ? titleMatch[1].trim() : '';

        // Extract date
        const dateMatch = innerHtml.match(/<time[^>]*>([^<]+)<\/time>/);
        const date = dateMatch ? dateMatch[1].trim() : '';

        if (title && slug && !title.includes('href=')) {
            // Deduplicate (their homepage often lists an article twice: featured and recent)
            if (!articles.find(a => a.id === slug)) {
                articles.push({
                    id: slug,
                    title: title.replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"'),
                    url: `https://anthropic.com/news/${slug}`,
                    source: 'Anthropic',
                    published_at: date ? new Date(date).toISOString() : new Date().toISOString(),
                    image_url: "",
                    news_site: 'Anthropic'
                });
            }
        }
    }

    // Fetch missing images using open-graph-scraper
    const topArticles = articles.slice(0, MAX_NEWS_ARTICLES);
    return Promise.all(topArticles.map(async (item, i) => {
        if (i < MAX_NEWS_ARTICLES) {
            try {
                const { result } = await ogs({ url: item.url, timeout: 4000 });
                if (result.ogImage && result.ogImage.length > 0) {
                    item.image_url = result.ogImage[0].url.replace(/&amp;/g, '&');
                }
            } catch (err) {
                console.error("OGS fetch failed for Anthropic article", item.url, err);
            }
        }
        return item;
    }));
}

async function fetchSpaceX() {
    console.info('[EXTERNAL API] Fetching from SpaceX API...');
    const res = await fetch('https://content.spacex.com/api/spacex-website/updates');
    if (!res.ok) {
        throw new Error(`Failed to fetch SpaceX news: ${res.status}`);
    }
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

async function fetchRocketLab() {
    console.info('[EXTERNAL API] Fetching from Rocket Lab News...');
    const res = await fetch('https://www.rocketlabusa.com/updates/', {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
        }
    });

    if (!res.ok) {
        throw new Error(`Failed to fetch Rocket Lab news: ${res.status}`);
    }
    const html = await res.text();

    const urlRegex = /href="(\/updates\/[^"]+)"/g;
    let match;
    const uniqueSlugs = new Set<string>();
    
    while ((match = urlRegex.exec(html)) !== null) {
        const slug = match[1];
        if (slug !== '/updates/' && slug.length > 15) {
            uniqueSlugs.add(slug);
        }
    }

    const articles = Array.from(uniqueSlugs).slice(0, MAX_NEWS_ARTICLES).map(slug => ({
        id: slug,
        title: "Rocket Lab News",
        url: `https://www.rocketlabusa.com${slug}`,
        source: 'Rocket Lab',
        published_at: new Date().toISOString(),
        image_url: "",
        news_site: 'Rocket Lab'
    }));

    return Promise.all(articles.map(async (item) => {
        try {
            const { result } = await ogs({ url: item.url, timeout: 4000 });
            if (result.ogTitle) {
                item.title = result.ogTitle.replace(/ \| Rocket Lab/g, '').trim();
            }
            if (result.ogImage && result.ogImage.length > 0) {
                item.image_url = result.ogImage[0].url.replace(/&amp;/g, '&');
            }
            if (result.articlePublishedTime) {
                item.published_at = new Date(result.articlePublishedTime).toISOString();
            } else if ((result as any).ogDate) {
                item.published_at = new Date((result as any).ogDate).toISOString();
            }
        } catch (err) {
            console.error("OGS fetch failed for Rocket Lab article", item.url, err);
        }
        return item;
    }));
}

async function fetchMeta() {
    console.info('[EXTERNAL API] Fetching from Meta AI News...');
    const res = await fetch('https://ai.meta.com/blog/', {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
    });

    if (!res.ok) {
        throw new Error(`Failed to fetch Meta AI news: ${res.status}`);
    }
    const html = await res.text();

    const articleRegex = /href="(?:https:\/\/ai\.meta\.com)?(\/blog\/[a-zA-Z0-9-]+\/?)"/g;
    let match;
    const articles: { id: string, title: string, url: string, source: string, published_at: string, image_url: string, news_site: string }[] = [];

    while ((match = articleRegex.exec(html)) !== null) {
        const slug = match[1];
        if (slug === '/blog/' || slug === '/blog') continue; // skip main blog link

        const url = `https://ai.meta.com${slug}`;
        if (!articles.find(a => a.url === url)) {
            articles.push({
                id: slug,
                title: "Meta AI News", // To be updated via OGS
                url: url,
                source: 'Meta AI',
                published_at: new Date().toISOString(),
                image_url: "",
                news_site: 'Meta AI'
            });
        }
    }

    const topArticles = articles.slice(0, MAX_NEWS_ARTICLES);
    return Promise.all(topArticles.map(async (item, i) => {
        try {
            const { result } = await ogs({ url: item.url, timeout: 4000 });
            if (result.ogTitle) {
                item.title = result.ogTitle.replace(' - AI at Meta', '').trim();
            }
            if (result.ogImage && result.ogImage.length > 0) {
                item.image_url = result.ogImage[0].url.replace(/&amp;/g, '&');
            }
            if (result.articlePublishedTime) {
                item.published_at = new Date(result.articlePublishedTime).toISOString();
            } else if ((result as any).ogDate) {
                item.published_at = new Date((result as any).ogDate).toISOString();
            }
        } catch (err) {
            console.error("OGS fetch failed for Meta article", item.url, err);
        }
        return item;
    }));
}

// Support other RSS feeds directly via URL
async function fetchGenericRSS(title: string, rssUrl: string) {
    console.info(`[EXTERNAL API] Fetching Generic RSS from: ${rssUrl}`);
    const feed = await parser.parseURL(rssUrl);
    let items = feed.items.slice(0, MAX_NEWS_ARTICLES).map(item => ({
        id: item.guid || item.link || Math.random().toString(),
        title: item.title || `${title} News`,
        url: item.link || "",
        source: title,
        published_at: item.isoDate || item.pubDate,
        image_url: "",
        news_site: title
    }));

    // Fetch images using OGS for generic feeds
    items = await Promise.all(items.map(async (item) => {
        if (item.url) {
            try {
                const { result } = await ogs({ url: item.url, timeout: 4000 });
                if (result.ogImage && result.ogImage.length > 0) {
                    item.image_url = result.ogImage[0].url.replace(/&amp;/g, '&');
                }
            } catch (err) {
                console.error(`OGS fetch failed for generic article ${item.url}`, err);
            }
        }
        return item;
    }));

    return items;
}

async function getHandler(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const company = searchParams.get('company')?.toLowerCase();

        let articles: any[] = [];

        if (company === 'spacex') {
            articles = await fetchSpaceX();
        } else if (company === 'rocketlab' || company === 'rocket-lab') {
            articles = await fetchRocketLab();
        } else if (company === 'openai') {
            articles = await fetchOpenAI();
        } else if (company === 'anthropic') {
            articles = await fetchAnthropic();
        } else if (company === 'meta') {
            articles = await fetchMeta();
        } else if (company === 'google' || company === 'deepmind') {
            articles = await fetchGenericRSS('Google DeepMind', 'https://deepmind.google/blog/rss.xml');
        } else if (company === 'microsoft') {
            articles = await fetchGenericRSS('Microsoft AI', 'https://blogs.microsoft.com/ai/feed/');
        } else if (company === 'nvidia') {
            articles = await fetchGenericRSS('Nvidia AI', 'https://blogs.nvidia.com/feed/');
        } else if (searchParams.has('rss')) {
            const rssUrl = searchParams.get('rss')!;
            const rssTitle = searchParams.get('title') || company || 'News';
            articles = await fetchGenericRSS(rssTitle, rssUrl);
        } else {
            return NextResponse.json({ error: 'Missing or unsupported company' }, { status: 400 });
        }

        return NextResponse.json(articles.slice(0, MAX_NEWS_ARTICLES));
    } catch (error) {
        console.error(`Error fetching company news:`, error);
        return NextResponse.json({ error: 'Failed to fetch company news' }, { status: 500 });
    }
}

// Create a wrapper function that passes request to handler
export const GET = withCache(getHandler, 3600);
