import { NextResponse } from 'next/server';

interface CacheEntry {
    data: any;
    expiry: number;
}

const globalCache = (globalThis as any).apiCache || new Map<string, CacheEntry>();
if (process.env.NODE_ENV !== 'production') {
    (globalThis as any).apiCache = globalCache;
}

export function withCache(handler: () => Promise<NextResponse>, ttlSeconds: number) {
    return async function (req: Request) {
        const url = new URL(req.url);
        const cacheKey = url.pathname + url.search;

        if (globalCache.has(cacheKey)) {
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

        const response = await handler();

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
