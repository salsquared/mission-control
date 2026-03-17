import { NextResponse } from 'next/server';

interface CacheEntry {
    data: any;
    expiry: number;
}

const globalCache: Map<string, CacheEntry> = (globalThis as any).apiCache || new Map<string, CacheEntry>();
const cacheStats: { hits: number, misses: number } = (globalThis as any).apiCacheStats || { hits: 0, misses: 0 };

if (process.env.NODE_ENV !== 'production') {
    (globalThis as any).apiCache = globalCache;
    (globalThis as any).apiCacheStats = cacheStats;
}

export function getCacheStats() {
    const activeEntries = Array.from(globalCache.entries()).map(([key, entry]) => ({
        key,
        remainingTtl: Math.max(0, Math.floor((entry.expiry - Date.now()) / 1000))
    }));
    return {
        hits: cacheStats.hits,
        misses: cacheStats.misses,
        activeEntries
    };
}

export function withCache(handler: (req: Request) => Promise<NextResponse>, ttlSeconds: number) {
    return async function (req: Request) {
        const url = new URL(req.url);
        // Remove cache buster 'v' to get base cache key
        const params = new URLSearchParams(url.search);
        const isRefresh = params.has('v');
        if (isRefresh) {
            params.delete('v');
        }

        let targetSearch = params.toString();
        if (targetSearch.length > 0) targetSearch = '?' + targetSearch;
        const cacheKey = url.pathname + targetSearch;

        let staleEntry: CacheEntry | null = null;

        if (!isRefresh && globalCache.has(cacheKey)) {
            const entry = globalCache.get(cacheKey)!;
            if (Date.now() < entry.expiry) {
                cacheStats.hits++;
                const remaining = Math.max(0, Math.floor((entry.expiry - Date.now()) / 1000));
                console.info(`[CACHE HIT] ${cacheKey} (TTL: ${remaining}s remaining)`);
                return NextResponse.json(entry.data, {
                    headers: {
                        'X-Cache': 'HIT',
                        'Cache-Control': `public, max-age=${ttlSeconds}, stale-while-revalidate=${ttlSeconds / 2}`
                    }
                });
            } else {
                staleEntry = entry;
            }
        }

        cacheStats.misses++;
        console.info(`[CACHE MISS] ${cacheKey} - Fetching fresh data (TTL set: ${ttlSeconds}s)`);
        
        let response: NextResponse | undefined;
        try {
            response = await handler(req);
        } catch (error) {
            if (staleEntry) {
                console.info(`[CACHE FALLBACK] ${cacheKey} - Handler threw error, returning stale data`);
                const retryTtl = 60;
                globalCache.set(cacheKey, {
                    data: staleEntry.data,
                    expiry: Date.now() + retryTtl * 1000
                });
                return NextResponse.json(staleEntry.data, {
                    headers: {
                        'X-Cache': 'STALE-FALLBACK',
                        'Cache-Control': `public, max-age=${retryTtl}, stale-while-revalidate=${retryTtl / 2}`
                    }
                });
            }
            throw error;
        }

        if (response.ok && response.headers.get('content-type')?.includes('application/json')) {
            const clone = response.clone();
            const data = await clone.json();
            globalCache.set(cacheKey, {
                data,
                expiry: Date.now() + ttlSeconds * 1000
            });
            response.headers.set('X-Cache', 'MISS');
            response.headers.set('Cache-Control', `public, max-age=${ttlSeconds}, stale-while-revalidate=${ttlSeconds / 2}`);
        } else if (!response.ok && staleEntry) {
            console.info(`[CACHE FALLBACK] ${cacheKey} - Fetch failed (${response.status}), returning stale data`);
            
            // Backoff: 60 seconds retry window to avoid spamming a failing API
            const retryTtl = 60;
            globalCache.set(cacheKey, {
                data: staleEntry.data,
                expiry: Date.now() + retryTtl * 1000
            });
            
            return NextResponse.json(staleEntry.data, {
                headers: {
                    'X-Cache': 'STALE-FALLBACK',
                    'Cache-Control': `public, max-age=${retryTtl}, stale-while-revalidate=${retryTtl / 2}`
                }
            });
        }

        return response;
    };
}

