import { NextResponse } from 'next/server';
import { withCache } from '../../../lib/cache';
import { MAX_NEWS_ARTICLES } from '../../../lib/constants';

const SNAPI_URL = `https://api.spaceflightnewsapi.net/v4/articles/?limit=100`;

async function getHandler() {
    try {
        const res = await fetch(SNAPI_URL, {
            next: { revalidate: 3600 }, // Cache for 1 hour
        });

        if (!res.ok) {
            throw new Error(`Failed to fetch Spaceflight News: ${res.status}`);
        }

        const data = await res.json();

        // Limit items to MAX_NEWS_ARTICLES *per* news site, not overall!
        const countsBySite: Record<string, number> = {};
        const balancedResults = [];

        for (const item of data.results) {
            const site = item.news_site;
            if (!countsBySite[site]) {
                countsBySite[site] = 0;
            }

            if (countsBySite[site] < MAX_NEWS_ARTICLES) {
                countsBySite[site]++;
                balancedResults.push(item);
            }
        }

        return NextResponse.json(balancedResults);
    } catch (error) {
        console.error('Error fetching space news:', error);
        return NextResponse.json({ error: 'Failed to fetch space news' }, { status: 500 });
    }
}

export const GET = withCache(getHandler, 3600);
