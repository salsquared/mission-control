import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

// Reset globals between tests
beforeEach(() => {
    (globalThis as any).apiCache = undefined;
    (globalThis as any).apiCacheStats = undefined;
    (globalThis as any).apiCacheInFlight = undefined;
});

// Dynamic import ensures fresh module state after global reset
async function loadCache() {
    vi.resetModules();
    // Mock prisma to avoid DB dependency
    vi.mock('@/lib/prisma', () => ({
        prisma: { cacheEntry: { findUnique: vi.fn().mockResolvedValue(null), upsert: vi.fn(), deleteMany: vi.fn().mockResolvedValue({ count: 0 }) } }
    }));
    const mod = await import('./cache');
    return mod;
}

function makeReq(path = '/api/test') {
    return new Request(`http://localhost${path}`);
}

describe('withCache — memory backend', () => {
    it('returns MISS on first request, HIT on second', async () => {
        const { withCache } = await loadCache();
        let callCount = 0;
        const handler = vi.fn(async () => {
            callCount++;
            return NextResponse.json({ value: callCount });
        });

        const wrapped = withCache(handler, 60);
        const r1 = await wrapped(makeReq());
        expect(r1.headers.get('X-Cache')).toBe('MISS');
        expect(await r1.json()).toEqual({ value: 1 });

        const r2 = await wrapped(makeReq());
        expect(r2.headers.get('X-Cache')).toBe('HIT');
        expect(handler).toHaveBeenCalledTimes(1);
    });

    it('returns STALE-FALLBACK when handler throws and stale entry exists', async () => {
        const { withCache } = await loadCache();
        let fail = false;
        const handler = vi.fn(async () => {
            if (fail) throw new Error('down');
            return NextResponse.json({ ok: true });
        });

        const wrapped = withCache(handler, 1); // 1s TTL
        await wrapped(makeReq()); // warm cache

        // Expire the entry manually
        const cache: Map<string, any> = (globalThis as any).apiCache;
        const entry = cache.get('/api/test');
        if (entry) entry.expiry = Date.now() - 1000;

        fail = true;
        const r = await wrapped(makeReq());
        expect(r.headers.get('X-Cache')).toBe('STALE-FALLBACK');
        expect(await r.json()).toEqual({ ok: true });
    });

    it('?v= busts the cache and forces a fresh fetch', async () => {
        const { withCache } = await loadCache();
        let n = 0;
        const handler = vi.fn(async () => NextResponse.json({ n: ++n }));
        const wrapped = withCache(handler, 60);

        await wrapped(makeReq('/api/test'));
        expect(handler).toHaveBeenCalledTimes(1);

        const bust = await wrapped(makeReq('/api/test?v=123'));
        expect(bust.headers.get('X-Cache')).toBe('MISS');
        expect(handler).toHaveBeenCalledTimes(2);
    });

    it('in-flight dedup calls handler only once for concurrent misses', async () => {
        const { withCache } = await loadCache();
        let callCount = 0;
        const handler = vi.fn(async () => {
            await new Promise(r => setTimeout(r, 10));
            callCount++;
            return NextResponse.json({ n: callCount });
        });

        const wrapped = withCache(handler, 60);
        const results = await Promise.all(
            Array.from({ length: 5 }, () => wrapped(makeReq()))
        );

        expect(handler).toHaveBeenCalledTimes(1);
        const bodies = await Promise.all(results.map(r => r.json()));
        expect(bodies.every(b => b.n === 1)).toBe(true);
    });
});
