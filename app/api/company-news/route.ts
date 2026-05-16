import { NextResponse } from 'next/server';
import { withCache } from '../../../lib/cache';
import { requireLocalOrSession } from '@/lib/auth-guards';
import { MAX_NEWS_ARTICLES } from '../../../lib/constants';
import { getAdapter, resolveCompanyId, getUpstreamHost } from '../../../lib/companies';
import { fetchRSS } from '../../../lib/fetchers';
import type { NewsArticle } from '../../../lib/fetchers/types';

// Opt out of Next.js built-in fetch cache — we handle caching ourselves via withCache
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

/**
 * Sort articles by published_at date, newest first.
 * Invalid or missing dates are pushed to the end.
 */
function sortByDate(articles: NewsArticle[]): NewsArticle[] {
    return articles.sort((a, b) => {
        const dateA = new Date(a.published_at).getTime();
        const dateB = new Date(b.published_at).getTime();
        // If either date is invalid (NaN), push it to the end
        if (isNaN(dateA) && isNaN(dateB)) return 0;
        if (isNaN(dateA)) return 1;
        if (isNaN(dateB)) return -1;
        return dateB - dateA; // Newest first
    });
}

async function getHandler(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const rawCompany = searchParams.get('company')?.toLowerCase();

        // Legacy support: generic RSS via ?rss= param
        if (searchParams.has('rss')) {
            const rssUrl = searchParams.get('rss')!;
            const rssTitle = searchParams.get('title') || rawCompany || 'News';
            const articles = await fetchRSS(rssTitle, rssUrl);
            return NextResponse.json(sortByDate(articles).slice(0, MAX_NEWS_ARTICLES));
        }

        if (!rawCompany) {
            return NextResponse.json({ error: 'Missing company parameter' }, { status: 400 });
        }

        const adapter = getAdapter(resolveCompanyId(rawCompany));
        if (!adapter) {
            return NextResponse.json(
                { error: `Unknown company: '${rawCompany}'. Check /api/company-news?list=true for available companies.` },
                { status: 400 }
            );
        }

        const articles = await adapter.fetch();
        return NextResponse.json(sortByDate(articles).slice(0, MAX_NEWS_ARTICLES));

    } catch (error) {
        console.error(`Error fetching company news:`, error);
        return NextResponse.json({ error: 'Failed to fetch company news' }, { status: 500 });
    }
}

function deriveUpstreamHost(req: Request): string | null {
    const params = new URL(req.url).searchParams;
    const rssParam = params.get('rss');
    if (rssParam) {
        try { return new URL(rssParam).hostname; } catch { return null; }
    }
    const raw = params.get('company')?.toLowerCase();
    if (!raw) return null;
    const adapter = getAdapter(resolveCompanyId(raw));
    return adapter ? getUpstreamHost(adapter) : null;
}

// Cache with 1hr TTL (individual company TTLs are aspirational for a future cache-per-key system)
const cachedGET = withCache(getHandler, { ttlSeconds: 3600, upstreamHost: deriveUpstreamHost });
export const GET = async (req: Request) => {
    const guard = await requireLocalOrSession(req);
    if ('error' in guard) return guard.error;
    return cachedGET(req);
};
