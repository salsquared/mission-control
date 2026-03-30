import { NextResponse } from 'next/server';
import { withCache } from '../../../lib/cache';
import { MAX_NEWS_ARTICLES } from '../../../lib/constants';
import { getCompanyConfig, resolveCompanyId } from '../../../lib/company-registry';
import { fetchRSS, fetchScrape, fetchSNAPI, fetchGoogleNews } from '../../../lib/fetchers';
import type { NewsArticle, CompanyFeedConfig } from '../../../lib/fetchers/types';

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

/**
 * Dispatch to the appropriate fetcher based on the company's configured strategy.
 */
async function fetchForCompany(config: CompanyFeedConfig): Promise<NewsArticle[]> {
    switch (config.strategy) {
        case 'rss':
            if (!config.rssUrl) throw new Error(`Missing rssUrl for ${config.name}`);
            return fetchRSS(config.name, config.rssUrl);

        case 'scrape':
            return fetchScrape(config);

        case 'snapi':
            if (!config.snapiQuery) throw new Error(`Missing snapiQuery for ${config.name}`);
            return fetchSNAPI(config.name, config.snapiQuery);

        case 'google-news':
            if (!config.googleNewsQuery) throw new Error(`Missing googleNewsQuery for ${config.name}`);
            return fetchGoogleNews(config.name, config.googleNewsQuery);

        case 'custom':
            if (!config.customFetcher) throw new Error(`Missing customFetcher for ${config.name}`);
            return config.customFetcher();

        case 'json-api':
            if (!config.apiUrl) throw new Error(`Missing apiUrl for ${config.name}`);
            // Generic JSON fetch — not used yet but ready for future
            const res = await fetch(config.apiUrl);
            if (!res.ok) throw new Error(`Failed to fetch ${config.name}: ${res.status}`);
            const data = await res.json();
            return config.apiTransform ? config.apiTransform(data) : data;

        default:
            throw new Error(`Unsupported strategy '${config.strategy}' for ${config.name}`);
    }
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

        // Resolve aliases and look up in registry
        const companyId = resolveCompanyId(rawCompany);
        const config = getCompanyConfig(companyId);

        if (!config) {
            return NextResponse.json(
                { error: `Unknown company: '${rawCompany}'. Check /api/company-news?list=true for available companies.` },
                { status: 400 }
            );
        }

        const articles = await fetchForCompany(config);
        return NextResponse.json(sortByDate(articles).slice(0, MAX_NEWS_ARTICLES));

    } catch (error) {
        console.error(`Error fetching company news:`, error);
        return NextResponse.json({ error: 'Failed to fetch company news' }, { status: 500 });
    }
}

// Cache with 1hr TTL (individual company TTLs are aspirational for a future cache-per-key system)
export const GET = withCache(getHandler, 3600);
