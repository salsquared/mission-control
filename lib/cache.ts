import { NextResponse } from 'next/server';
import { prisma } from './prisma';

interface L1Entry {
    data: any;
    expiry: number;
}

const globalCache: Map<string, L1Entry> = (globalThis as any).apiCache || new Map<string, L1Entry>();
const cacheStats: { hits: number; misses: number } = (globalThis as any).apiCacheStats || { hits: 0, misses: 0 };
const inFlight: Map<string, Promise<NextResponse>> = (globalThis as any).apiCacheInFlight || new Map();

if (process.env.NODE_ENV !== 'production') {
    if (!(globalThis as any).apiCache) {
        (globalThis as any).apiCache = globalCache;
        (globalThis as any).apiCacheStats = cacheStats;
        (globalThis as any).apiCacheInFlight = inFlight;
        console.info(`[CACHE] Initialized (backend: ${process.env.CACHE_BACKEND || 'memory'})`);
    }
}

const useSQLite = () => process.env.CACHE_BACKEND === 'sqlite';

export function getCacheStats() {
    const activeEntries = Array.from(globalCache.entries()).map(([key, entry]) => ({
        key,
        remainingTtl: Math.max(0, Math.floor((entry.expiry - Date.now()) / 1000))
    }));
    return { hits: cacheStats.hits, misses: cacheStats.misses, activeEntries };
}

async function l2Read(key: string): Promise<L1Entry | null> {
    try {
        const row = await prisma.cacheEntry.findUnique({ where: { key } });
        if (!row) return null;
        const expiry = new Date(row.expiry).getTime();
        if (expiry <= Date.now()) return null;
        return { data: JSON.parse(row.data), expiry };
    } catch {
        return null;
    }
}

async function l2Write(key: string, data: any, expiry: number): Promise<void> {
    try {
        await prisma.cacheEntry.upsert({
            where: { key },
            update: { data: JSON.stringify(data), expiry: new Date(expiry) },
            create: { key, data: JSON.stringify(data), expiry: new Date(expiry) },
        });
    } catch (e) {
        console.warn(`[CACHE] L2 write failed for ${key}:`, e);
    }
}

export async function pruneExpiredCache(): Promise<void> {
    if (!useSQLite()) return;
    try {
        const result = await prisma.cacheEntry.deleteMany({
            where: { expiry: { lt: new Date() } },
        });
        if (result.count > 0) {
            console.info(`[CACHE] Pruned ${result.count} expired entries from SQLite`);
        }
    } catch (e) {
        console.warn('[CACHE] Prune failed:', e);
    }
}

export function withCache(handler: (req: Request) => Promise<NextResponse>, ttlSeconds: number) {
    return async function (req: Request) {
        const url = new URL(req.url);
        const params = new URLSearchParams(url.search);
        const isRefresh = params.has('v');
        if (isRefresh) params.delete('v');

        let targetSearch = params.toString();
        if (targetSearch) targetSearch = '?' + targetSearch;
        const cacheKey = url.pathname + targetSearch;

        let staleEntry: L1Entry | null = null;

        // --- L1 check ---
        if (!isRefresh && globalCache.has(cacheKey)) {
            const entry = globalCache.get(cacheKey)!;
            if (Date.now() < entry.expiry) {
                cacheStats.hits++;
                const remaining = Math.max(0, Math.floor((entry.expiry - Date.now()) / 1000));
                console.info(`[CACHE HIT] ${cacheKey} (TTL: ${remaining}s remaining)`);
                return NextResponse.json(entry.data, {
                    headers: {
                        'X-Cache': 'HIT',
                        'Cache-Control': buildCacheControl(ttlSeconds),
                    },
                });
            } else {
                staleEntry = entry;
            }
        }

        // --- L2 check (SQLite, only if enabled) ---
        if (!isRefresh && !staleEntry && useSQLite()) {
            const l2 = await l2Read(cacheKey);
            if (l2) {
                cacheStats.hits++;
                globalCache.set(cacheKey, l2);
                const remaining = Math.max(0, Math.floor((l2.expiry - Date.now()) / 1000));
                console.info(`[CACHE HIT L2] ${cacheKey} (TTL: ${remaining}s remaining)`);
                return NextResponse.json(l2.data, {
                    headers: {
                        'X-Cache': 'HIT',
                        'Cache-Control': buildCacheControl(ttlSeconds),
                    },
                });
            }
        }

        cacheStats.misses++;
        console.info(`[CACHE MISS] ${cacheKey} - Fetching fresh data (TTL: ${ttlSeconds}s)`);

        // In-flight dedup: if another request for the same key is already running, await it.
        if (inFlight.has(cacheKey)) {
            return inFlight.get(cacheKey)!.then(r => r.clone());
        }

        let response: NextResponse | undefined;
        const fetchPromise = (async () => {
        try {
            return await handler(req);
        } catch (error) {
            if (staleEntry) {
                return serveStale(cacheKey, staleEntry, 60);
            }
            throw error;
        }
        })();
        inFlight.set(cacheKey, fetchPromise);
        try {
            response = await fetchPromise;
        } finally {
            inFlight.delete(cacheKey);
        }

        // If the fetchPromise resolved to a stale-fallback (handler threw), propagate it directly.
        if (response.headers.get('X-Cache') === 'STALE-FALLBACK') {
            return response;
        }

        if (response.ok && response.headers.get('content-type')?.includes('application/json')) {
            const data = await response.clone().json();
            const expiry = Date.now() + ttlSeconds * 1000;
            globalCache.set(cacheKey, { data, expiry });
            if (useSQLite()) await l2Write(cacheKey, data, expiry);
            response.headers.set('X-Cache', 'MISS');
            response.headers.set('Cache-Control', buildCacheControl(ttlSeconds));
        } else if (!response.ok && staleEntry) {
            return serveStale(cacheKey, staleEntry, 60);
        }

        return response;
    };
}

function buildCacheControl(ttlSeconds: number): string {
    if (process.env.NODE_ENV === 'production') {
        return `private, max-age=${ttlSeconds}, stale-while-revalidate=${Math.floor(ttlSeconds / 2)}`;
    }
    return 'private, no-store, max-age=0';
}

function serveStale(cacheKey: string, entry: L1Entry, retryTtl: number): NextResponse {
    console.info(`[CACHE FALLBACK] ${cacheKey} - Returning stale data`);
    const expiry = Date.now() + retryTtl * 1000;
    globalCache.set(cacheKey, { data: entry.data, expiry });
    if (useSQLite()) l2Write(cacheKey, entry.data, expiry).catch(() => {});
    return NextResponse.json(entry.data, {
        headers: {
            'X-Cache': 'STALE-FALLBACK',
            'Cache-Control': 'private, no-store, max-age=0',
        },
    });
}
