import { pruneExpiredCache } from '../../lib/cache';

// Wraps lib/cache.ts:pruneExpiredCache so the scheduler can call it without
// caring about the (CACHE_BACKEND=sqlite-gated) implementation detail. Returns
// a no-op promise when the durable cache backend is disabled.
export async function runCachePrune(): Promise<void> {
    await pruneExpiredCache();
}
