import { NextResponse } from 'next/server';
import { withCache } from '../../../lib/cache';

// Using Hacker News Algolia Search API for "AI" or "Artificial Intelligence"
const HN_SEARCH_URL = 'https://hn.algolia.com/api/v1/search_by_date?query="Artificial Intelligence" OR "AI"&tags=story&hitsPerPage=30';

async function getHandler() {
    try {
        const res = await fetch(HN_SEARCH_URL, {
            next: { revalidate: 3600 }, // Cache for 1 hour
        });

        if (!res.ok) {
            throw new Error(`Failed to fetch AI news: ${res.status}`);
        }

        const data = await res.json();

        // Transform HN data to a more generic format
        const formattedNews = data.hits.map((hit: any) => ({
            id: hit.objectID,
            title: hit.title,
            url: hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`,
            source: 'Hacker News',
            published_at: hit.created_at,
            publishedAt: hit.created_at,
            author: hit.author,
            image_url: "",
            news_site: 'Hacker News'
        }));

        return NextResponse.json(formattedNews);
    } catch (error) {
        console.error('Error fetching AI news:', error);
        return NextResponse.json({ error: 'Failed to fetch AI news' }, { status: 500 });
    }
}

export const GET = withCache(getHandler, 3600); // 1 hour TTL
