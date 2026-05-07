import { prisma } from '@/lib/prisma';

// Persisted L2 entries for the withCache wrapper. The L1 in-memory map and the
// stale-fallback logic stay in lib/cache.ts; this repo only owns SQLite I/O.

export interface CacheEntryRow {
    key: string;
    data: string;   // JSON-serialized response body
    expiry: Date;
}

export function findCacheEntry(key: string): Promise<CacheEntryRow | null> {
    return prisma.cacheEntry.findUnique({ where: { key } });
}

export async function upsertCacheEntry(entry: CacheEntryRow): Promise<void> {
    await prisma.cacheEntry.upsert({
        where: { key: entry.key },
        update: { data: entry.data, expiry: entry.expiry },
        create: entry,
    });
}

export async function deleteExpiredCacheEntries(): Promise<number> {
    const result = await prisma.cacheEntry.deleteMany({
        where: { expiry: { lt: new Date() } },
    });
    return result.count;
}
