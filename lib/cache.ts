/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from 'next/server';

interface CacheEntry {
    data: any;
    expiry: number;
}

const globalCache = (globalThis as any).apiCache || new Map<string, CacheEntry>();
if (process.env.NODE_ENV !== 'production') {
    (globalThis as any).apiCache = globalCache;
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

        if (!isRefresh && globalCache.has(cacheKey)) {
            const entry = globalCache.get(cacheKey)!;
            if (Date.now() < entry.expiry) {
                return NextResponse.json(entry.data, {
                    headers: {
                        'X-Cache': 'HIT',
                        'Cache-Control': `public, max-age=${ttlSeconds}, stale-while-revalidate=${ttlSeconds / 2}`
                    }
                });
            } else {
                globalCache.delete(cacheKey);
            }
        }

        const response = await handler(req);

        if (response.ok && response.headers.get('content-type')?.includes('application/json')) {
            const clone = response.clone();
            const data = await clone.json();
            globalCache.set(cacheKey, {
                data,
                expiry: Date.now() + ttlSeconds * 1000
            });
            response.headers.set('X-Cache', 'MISS');
            response.headers.set('Cache-Control', `public, max-age=${ttlSeconds}, stale-while-revalidate=${ttlSeconds / 2}`);
        }

        return response;
    };
}

