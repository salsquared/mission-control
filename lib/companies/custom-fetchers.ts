import { MAX_NEWS_ARTICLES } from '../constants';
import type { NewsArticle } from '../fetchers/types';
import { loggedFetch, logExternalCall } from '../external-fetch';

export const TTL_STANDARD = 3600;
export const TTL_LOW_VOLUME = 86400;
export const TTL_VERY_LOW = 604800;

export async function fetchSpaceX(): Promise<NewsArticle[]> {
    const res = await loggedFetch('https://content.spacex.com/api/spacex-website/updates');
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

export async function fetchOpenAI(): Promise<NewsArticle[]> {
    const Parser = (await import('rss-parser')).default;
    const parser = new Parser();
    logExternalCall('https://openai.com/news/rss.xml');
    const feed = await parser.parseURL('https://openai.com/news/rss.xml');
    const items = feed.items.slice(0, MAX_NEWS_ARTICLES);

    return Promise.all(items.map(async (item, i) => {
        let image_url = "";
        if (i < 4 && item.link) {
            try {
                const res = await loggedFetch(`https://api.microlink.io?url=${encodeURIComponent(item.link)}`);
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

export async function fetchGroq(): Promise<NewsArticle[]> {
    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
    const cardRegex = /<time\s+dateTime="([^"]+)"[^>]*>[^<]*<\/time>[\s\S]*?<img\s+src="([^"]+)"[\s\S]*?<a\s+href="(\/(?:blog|newsroom)\/[a-zA-Z0-9-]+(?:\/[a-zA-Z0-9-]+)*)"[^>]*>([^<]+)<\/a>/g;
    const pages = ['https://groq.com/blog', 'https://groq.com/newsroom'];
    const seen = new Set<string>();
    const allArticles: NewsArticle[] = [];

    const results = await Promise.allSettled(pages.map(async (pageUrl) => {
        const res = await loggedFetch(pageUrl, { headers: { 'User-Agent': UA } });
        if (!res.ok) throw new Error(`Failed to fetch ${pageUrl}: ${res.status}`);
        const html = await res.text();
        const re = new RegExp(cardRegex.source, cardRegex.flags);
        let match;
        while ((match = re.exec(html)) !== null) {
            const [, dateTime, imgSrc, slug, title] = match;
            if (!slug || slug.length < 15) continue;
            const fullUrl = `https://groq.com${slug}`;
            if (seen.has(fullUrl)) continue;
            seen.add(fullUrl);
            allArticles.push({
                id: slug,
                title: (title || 'Groq News').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').trim(),
                url: fullUrl,
                source: 'Groq',
                published_at: dateTime ? dateTime.replace('T00:00:00.000Z', 'T12:00:00.000Z') : new Date().toISOString(),
                image_url: (imgSrc || '').replace(/&amp;/g, '&'),
                news_site: 'Groq',
            });
        }
    }));

    results.forEach((r, i) => {
        if (r.status === 'rejected') console.error(`[SCRAPE] Groq page ${pages[i]} failed:`, r.reason);
    });

    allArticles.sort((a, b) => new Date(b.published_at).getTime() - new Date(a.published_at).getTime());
    return allArticles.slice(0, MAX_NEWS_ARTICLES);
}

export async function fetchCerebras(): Promise<NewsArticle[]> {
    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
    const res = await loggedFetch('https://cerebras.ai/blog', { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`Failed to fetch cerebras blog: ${res.status}`);
    const html = await res.text();

    const aRegex = /<a[^>]*href="(\/blog\/[a-zA-Z0-9][a-zA-Z0-9-]+)"[^>]*>([\s\S]*?)<\/a>/g;
    const months = 'January|February|March|April|May|June|July|August|September|October|November|December';
    const dateRe = new RegExp(`text-disabled-foreground">((?:${months})\\s+\\d{1,2},\\s+\\d{4})<\\/p>`);
    const titleRe = /<(?:h2|h3)[^>]*>([\s\S]*?)<\/(?:h2|h3)>/;
    const imgRe = /<img[^>]*\ssrc="([^"]+)"/;

    let match;
    const seen = new Set<string>();
    const allArticles: NewsArticle[] = [];

    while ((match = aRegex.exec(html)) !== null) {
        const [, slug, inner] = match;
        if (seen.has(slug)) continue;
        const dateMatch = inner.match(dateRe);
        const titleMatch = inner.match(titleRe);
        if (!dateMatch || !titleMatch) continue;
        seen.add(slug);
        const imgMatch = inner.match(imgRe);
        const title = titleMatch[1].trim().replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"');
        const parsedDate = new Date(dateMatch[1]);
        allArticles.push({
            id: slug,
            title,
            url: `https://cerebras.ai${slug}`,
            source: 'Cerebras',
            published_at: isNaN(parsedDate.getTime()) ? new Date().toISOString() : parsedDate.toISOString(),
            image_url: imgMatch ? imgMatch[1].replace(/&amp;/g, '&') : "",
            news_site: 'Cerebras',
        });
    }

    allArticles.sort((a, b) => new Date(b.published_at).getTime() - new Date(a.published_at).getTime());
    return allArticles.slice(0, MAX_NEWS_ARTICLES);
}

export async function fetchMetaAI(): Promise<NewsArticle[]> {
    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
    const res = await loggedFetch('https://ai.meta.com/blog/', { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`Failed to fetch Meta AI blog: ${res.status}`);
    const html = await res.text();

    const datePattern = '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\s+\\d{1,2},\\s+\\d{4}';
    const urlDateMap = new Map<string, { date: string; title: string }>();
    const urlRegex = /href="(https:\/\/ai\.meta\.com\/blog\/([a-zA-Z0-9][a-zA-Z0-9-]+)\/)"/g;
    let um;

    while ((um = urlRegex.exec(html)) !== null) {
        const [, url, slug] = um;
        if (slug.startsWith('?') || slug === 'page') continue;
        if (urlDateMap.has(url)) continue;

        const afterBlock = html.substring(um.index, Math.min(html.length, um.index + 2000));
        const afterMatch = afterBlock.match(new RegExp(datePattern));
        const beforeBlock = html.substring(Math.max(0, um.index - 500), um.index);
        const beforeMatches = beforeBlock.match(new RegExp(datePattern, 'g'));
        const beforeMatch = beforeMatches ? beforeMatches[beforeMatches.length - 1] : null;

        let date = '';
        if (afterMatch) {
            const afterDist = afterBlock.indexOf(afterMatch[0]);
            const beforeDist = beforeMatch ? (500 - beforeBlock.lastIndexOf(beforeMatch)) : Infinity;
            date = afterDist < beforeDist ? afterMatch[0] : (beforeMatch || afterMatch[0]);
        } else if (beforeMatch) {
            date = beforeMatch;
        }

        let title = '';
        const escapedUrl = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const ariaMatch = afterBlock.match(new RegExp(`aria-label="(?:Read\\s+)?([^"]+)"[^>]*href="${escapedUrl}"`))
            || beforeBlock.match(new RegExp(`aria-label="(?:Read\\s+)?([^"]+)"[^>]*href="${escapedUrl}"`));
        if (ariaMatch) {
            title = ariaMatch[1];
        } else {
            const textMatch = afterBlock.match(new RegExp(`href="${escapedUrl}"[^>]*>([^<]{10,})</a>`));
            if (textMatch) title = textMatch[1];
        }
        title = title.replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&#039;/g, "'").replace(/&quot;/g, '"').trim();
        urlDateMap.set(url, { date, title });
    }

    const allArticles: NewsArticle[] = [];
    for (const [url, { date, title }] of urlDateMap) {
        const slug = new URL(url).pathname.replace('/blog/', '').replace(/\/$/, '');
        const parsedDate = new Date(date);
        const escapedUrl = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const imgPat = new RegExp(`href="${escapedUrl}"[\\s\\S]{0,500}?<img[^>]*src="([^"]+)"`, 'i');
        const imgMatch = html.match(imgPat);
        allArticles.push({
            id: slug,
            title: title || `Meta AI: ${slug.replace(/-/g, ' ')}`,
            url,
            source: 'Meta AI',
            published_at: isNaN(parsedDate.getTime()) ? new Date().toISOString() : parsedDate.toISOString(),
            image_url: imgMatch ? imgMatch[1].replace(/&amp;/g, '&') : '',
            news_site: 'Meta AI',
        });
    }

    allArticles.sort((a, b) => new Date(b.published_at).getTime() - new Date(a.published_at).getTime());
    return allArticles.slice(0, MAX_NEWS_ARTICLES);
}
