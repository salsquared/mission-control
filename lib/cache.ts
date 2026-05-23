import { NextResponse } from 'next/server';
import {
    findCacheEntry,
    upsertCacheEntry,
    deleteExpiredCacheEntries,
    deleteCacheEntry,
    deleteCacheEntriesByPrefix,
    listFreshCacheEntries,
} from '@/lib/repositories/cache-entries';
import { broadcastEvent } from '@/lib/events';

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

// `[CACHE HIT]` / `[CACHE MISS]` fire on every withCache route call. In dev
// that's high-volume noise into the SSE log fan-out (see lib/logger.ts) —
// every line walks the patched console + ring buffer + every subscriber.
// Prod keeps these on because the in-app log viewer is the canonical
// observability surface (CLAUDE.md). DEBUG_VERBOSE_LOG=1 re-enables them
// in dev for active debugging of cache behavior.
const LOG_VERBOSE =
    process.env.NODE_ENV === 'production' || process.env.DEBUG_VERBOSE_LOG === '1';

// Sweep expired L1 entries every 5 min. Without this, expired-but-not-
// revisited keys stay in the map indefinitely, each holding its full
// response body (company news feeds, arXiv listings, etc.). For a single-
// node dev process this is a slow leak; for a long-uptime prod process
// it's load-bearing. HMR-safe via globalThis.
const L1_PRUNE_INTERVAL_MS = 5 * 60 * 1000;
function pruneExpiredL1(): number {
    const now = Date.now();
    let pruned = 0;
    for (const [key, entry] of globalCache) {
        if (entry.expiry <= now) {
            globalCache.delete(key);
            pruned++;
        }
    }
    if (pruned > 0 && LOG_VERBOSE) {
        console.info(`[CACHE] L1 pruned ${pruned} expired entries`);
    }
    return pruned;
}
if (!(globalThis as any).__apiCachePruner) {
    (globalThis as any).__apiCachePruner = setInterval(pruneExpiredL1, L1_PRUNE_INTERVAL_MS);
    // Don't let the timer hold the event loop open at shutdown.
    if (typeof (globalThis as any).__apiCachePruner?.unref === 'function') {
        (globalThis as any).__apiCachePruner.unref();
    }
}

// Merges L1 (in-memory) and L2 (SQLite) entries so the telemetry reflects the
// real cache footprint. Pre-prune-7 (May 20), L1 retained every entry forever
// and looked like the full cache. With the 5-min L1 prune, L1 is just a hot
// working set — most cached payloads live exclusively in L2. Read L1 first
// (authoritative for keys present in both), then union in L2-only keys.
// Filters out expired-but-not-yet-pruned L1 entries so the telemetry list
// matches what would actually serve a request.
export async function getCacheStats() {
    const now = Date.now();
    const merged = new Map<string, number>(); // key → expiry (ms)
    for (const [key, entry] of globalCache) {
        if (entry.expiry > now) merged.set(key, entry.expiry);
    }
    if (useSQLite()) {
        try {
            const rows = await listFreshCacheEntries();
            for (const row of rows) {
                if (!merged.has(row.key)) {
                    merged.set(row.key, new Date(row.expiry).getTime());
                }
            }
        } catch (e) {
            console.warn('[CACHE] L2 telemetry read failed — returning L1 only:', e);
        }
    }
    const activeEntries = Array.from(merged.entries()).map(([key, expiry]) => ({
        key,
        remainingTtl: Math.max(0, Math.floor((expiry - now) / 1000)),
    }));
    return { hits: cacheStats.hits, misses: cacheStats.misses, activeEntries };
}

async function l2Read(key: string): Promise<L1Entry | null> {
    try {
        const row = await findCacheEntry(key);
        if (!row) return null;
        const expiry = new Date(row.expiry).getTime();
        if (expiry <= Date.now()) return null;
        return { data: JSON.parse(row.data), expiry };
    } catch {
        return null;
    }
}

// Recover the last cached payload for `key` even if its TTL has expired and
// it isn't in the in-process L1 map. Used by upstream-aware routes (currently
// just /api/space/satellites) when the upstream signals "your prior download
// is still current" (Celestrak's 403 "GP data has not updated") so they can
// serve last-good data instead of bubbling a 500 to the dashboard.
// Returns the data payload only — callers attach their own response shape.
export async function readCachedDataIgnoringExpiry(key: string): Promise<any | null> {
    const l1 = globalCache.get(key);
    if (l1) return l1.data;
    if (!useSQLite()) return null;
    try {
        const row = await findCacheEntry(key);
        if (!row) return null;
        return JSON.parse(row.data);
    } catch {
        return null;
    }
}

async function l2Write(key: string, data: any, expiry: number): Promise<void> {
    try {
        await upsertCacheEntry({
            key,
            data: JSON.stringify(data),
            expiry: new Date(expiry),
        });
    } catch (e) {
        console.warn(`[CACHE] L2 write failed for ${key}:`, e);
    }
}

export async function pruneExpiredCache(): Promise<void> {
    if (!useSQLite()) return;
    try {
        const count = await deleteExpiredCacheEntries();
        if (count > 0) {
            console.info(`[CACHE] Pruned ${count} expired entries from SQLite`);
        }
    } catch (e) {
        console.warn('[CACHE] Prune failed:', e);
    }
}

// Drop a single cache key from L1 + L2 and broadcast a 'Cache' invalidation
// event so connected clients refetch. Returns true if the key was present in
// the L1 map (we don't await L2 to keep the call non-blocking; the broadcast
// fires regardless because connected clients should refetch in either case).
export function invalidateCacheKey(key: string): boolean {
    const had = globalCache.has(key);
    globalCache.delete(key);
    inFlight.delete(key);
    if (useSQLite()) {
        deleteCacheEntry(key).catch((e) => console.warn(`[CACHE INVALIDATE] L2 delete failed for ${key}:`, e));
    }
    console.info(`[CACHE INVALIDATE] ${key}${had ? '' : ' (not in L1)'}`);
    broadcastEvent({ model: 'Cache', action: 'invalidate', id: key, timestamp: Date.now() });
    return had;
}

// Drop every cache key whose pathname-portion starts with `prefix`. Useful
// for invalidating a whole route family (e.g., '/api/research') in one call.
// Broadcasts a single 'Cache' event with the prefix marker.
export function invalidateCacheByPrefix(prefix: string): number {
    let count = 0;
    for (const key of Array.from(globalCache.keys())) {
        if (key.startsWith(prefix)) {
            globalCache.delete(key);
            inFlight.delete(key);
            count++;
        }
    }
    if (useSQLite()) {
        deleteCacheEntriesByPrefix(prefix).catch((e) => console.warn(`[CACHE INVALIDATE] L2 prefix delete failed for ${prefix}:`, e));
    }
    if (count > 0 || useSQLite()) {
        console.info(`[CACHE INVALIDATE] prefix=${prefix} (${count} L1 keys)`);
        broadcastEvent({ model: 'Cache', action: 'invalidate', id: `${prefix}*`, timestamp: Date.now() });
    }
    return count;
}

/**
 * Generic key→value cache for non-HTTP callers — e.g. POST routes that need
 * to key on body content, or any orchestrator that wants a memoized async
 * computation. Same L1+L2 semantics as withCache():
 *   - L1: in-process Map (HMR-safe via globalThis)
 *   - L2: SQLite when CACHE_BACKEND=sqlite, survives restart
 *   - in-flight dedup so concurrent callers with the same key share one
 *     pending fetcher promise
 *
 * Callers own the key. Prefix it (e.g. "discovery:suggest:") for groupable
 * invalidation via invalidateCacheByPrefix().
 *
 * Does NOT do the stale-fallback dance withCache uses — those semantics are
 * tied to NextResponse construction and don't generalize cleanly. If the
 * fetcher throws, the error propagates and no cache entry is written.
 */
export async function cachedValue<T>(
    key: string,
    ttlSeconds: number,
    fetcher: () => Promise<T>,
): Promise<T> {
    const l1 = globalCache.get(key);
    if (l1 && l1.expiry > Date.now()) {
        cacheStats.hits++;
        return l1.data as T;
    }
    if (useSQLite()) {
        const l2 = await l2Read(key);
        if (l2) {
            globalCache.set(key, l2);
            cacheStats.hits++;
            return l2.data as T;
        }
    }
    // In-flight dedup — reuse the existing inFlight map even though its value
    // type is Promise<NextResponse>, since we never read the queued promise's
    // type back out. Cast on insert/read locally.
    const inFlightMap = inFlight as unknown as Map<string, Promise<T>>;
    const pending = inFlightMap.get(key);
    if (pending) return pending;
    const p = (async () => {
        try {
            const value = await fetcher();
            const expiry = Date.now() + ttlSeconds * 1000;
            globalCache.set(key, { data: value, expiry });
            if (useSQLite()) await l2Write(key, value, expiry);
            cacheStats.misses++;
            return value;
        } finally {
            inFlightMap.delete(key);
        }
    })();
    inFlightMap.set(key, p);
    return p;
}

export type UpstreamHost = string | ((req: Request) => string | null | undefined);

// RAH-5: hook for scoping cache entries to a user identity. When provided,
// the returned value is prepended to the cache key so two users hitting the
// same route get separate entries. Mission-control is single-user today and
// all `withCache`-wrapped routes return shared external-data feeds, so no
// caller passes this yet — but the hook exists so a future caller that wraps
// a user-specific route can opt in without rewriting the cache layer.
export type UserCacheKeyFn = (req: Request) => string | null | undefined | Promise<string | null | undefined>;

export interface WithCacheOptions {
    ttlSeconds: number;
    // Upstream host this route ultimately calls. Logged with each cache event so the
    // Internal Systems "Fetcher Health" card can group by real host instead of by route path.
    upstreamHost?: UpstreamHost;
    // Optional per-user scoping. See UserCacheKeyFn above. If you wrap a route
    // that returns user-specific data, set this to ensure cache isolation.
    userKeyFn?: UserCacheKeyFn;
}

export function withCache(
    handler: (req: Request) => Promise<NextResponse>,
    ttlOrOpts: number | WithCacheOptions
) {
    const opts: WithCacheOptions =
        typeof ttlOrOpts === 'number' ? { ttlSeconds: ttlOrOpts } : ttlOrOpts;
    const { ttlSeconds, upstreamHost, userKeyFn } = opts;

    return async function (req: Request) {
        const url = new URL(req.url);
        const params = new URLSearchParams(url.search);
        const isRefresh = params.has('v');
        if (isRefresh) params.delete('v');

        let targetSearch = params.toString();
        if (targetSearch) targetSearch = '?' + targetSearch;
        // Optional per-user prefix on the cache key. Defensive — see RAH-5
        // comment on UserCacheKeyFn for the multi-user motivation.
        let userPrefix = '';
        if (userKeyFn) {
            try {
                const key = await userKeyFn(req);
                if (key) userPrefix = `u:${key}|`;
            } catch (e) {
                console.warn('[CACHE] userKeyFn threw — falling back to shared key:', e);
            }
        }
        const cacheKey = userPrefix + url.pathname + targetSearch;

        const host =
            (typeof upstreamHost === 'function' ? upstreamHost(req) : upstreamHost) || null;
        const hostTag = host ? `${host} ` : '';

        let staleEntry: L1Entry | null = null;

        // --- L1 check ---
        if (!isRefresh && globalCache.has(cacheKey)) {
            const entry = globalCache.get(cacheKey)!;
            if (Date.now() < entry.expiry) {
                cacheStats.hits++;
                if (LOG_VERBOSE) {
                    const remaining = Math.max(0, Math.floor((entry.expiry - Date.now()) / 1000));
                    console.info(`[CACHE HIT] ${hostTag}${cacheKey} (TTL: ${remaining}s remaining)`);
                }
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
                if (LOG_VERBOSE) {
                    const remaining = Math.max(0, Math.floor((l2.expiry - Date.now()) / 1000));
                    console.info(`[CACHE HIT L2] ${hostTag}${cacheKey} (TTL: ${remaining}s remaining)`);
                }
                return NextResponse.json(l2.data, {
                    headers: {
                        'X-Cache': 'HIT',
                        'Cache-Control': buildCacheControl(ttlSeconds),
                    },
                });
            }
        }

        cacheStats.misses++;
        if (LOG_VERBOSE) {
            console.info(`[CACHE MISS] ${hostTag}${cacheKey} - Fetching fresh data (TTL: ${ttlSeconds}s)`);
        }

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
                return serveStale(cacheKey, staleEntry, 60, host);
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
            return serveStale(cacheKey, staleEntry, 60, host);
        }

        return response;
    };
}

function buildCacheControl(_ttlSeconds: number): string {
    // Always no-store. Previously prod emitted `max-age=ttl` so the browser
    // HTTP cache held responses for hours/days, but that short-circuits the
    // browser → server → withCache path: the browser served the second
    // request from its own disk cache and `cacheStats.hits` never
    // incremented (Internal Systems dash showed 0% hit rate for days).
    // With no-store, every browser fetch traverses the server, the in-
    // process L1+L2 serves it in <1 ms, and the in-app telemetry reflects
    // reality. Service worker NetworkFirst still owns offline fallback.
    return 'private, no-store, max-age=0';
}

function serveStale(cacheKey: string, entry: L1Entry, retryTtl: number, host: string | null = null): NextResponse {
    const hostTag = host ? `${host} ` : '';
    console.info(`[CACHE FALLBACK] ${hostTag}${cacheKey} - Returning stale data`);
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
