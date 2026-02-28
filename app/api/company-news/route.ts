import { NextResponse } from 'next/server';
import { withCache } from '../../../lib/cache';
import Parser from 'rss-parser';
import ogs from 'open-graph-scraper';
import { MAX_NEWS_ARTICLES } from '../../../lib/constants';

const parser = new Parser();

async function fetchOpenAI() {
    const feed = await parser.parseURL('https://openai.com/news/rss.xml');

    const items = feed.items.slice(0, MAX_NEWS_ARTICLES);

    return Promise.all(items.map(async (item, i) => {
        let image_url = "";
        // Try getting image via microlink API for the first 4 items to save on rate limits, as it bypasses Cloudflare
        if (i < 4 && item.link) {
            try {
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

// Support other RSS feeds directly via URL
async function fetchGenericRSS(title: string, rssUrl: string) {
    const feed = await parser.parseURL(rssUrl);
    const items = feed.items.slice(0, MAX_NEWS_ARTICLES);
    return items.map(item => ({
        id: item.guid || item.link || Math.random().toString(),
        title: item.title || `${title} News`,
        url: item.link || "",
        source: title,
        published_at: item.isoDate || item.pubDate,
        news_site: title
    }));
}

async function getHandler(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const company = searchParams.get('company')?.toLowerCase();

        let articles: any[] = [];

        if (company === 'openai') {
            articles = await fetchOpenAI();
        } else if (company === 'anthropic') {
            articles = await fetchAnthropic();
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
