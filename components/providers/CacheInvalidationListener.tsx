"use client";

import { useCallback, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useServerEvents } from "@/hooks/useServerEvents";

// When the server invalidates a withCache entry (lib/cache.ts:invalidateCacheKey
// or invalidateCacheByPrefix), it broadcasts a 'Cache' SSE event. This listener
// translates that into queryClient.invalidateQueries() so every TanStack query
// on this client refetches.
//
// The mapping is heavy-handed (any cache invalidation refetches all queries)
// rather than fine-grained, because TanStack query keys (`['research', 'ai',
// 'review']`) and withCache keys (URL pathname + sorted query) don't share a
// schema. Refetching all queries is cheap at our scale (~10 active queries,
// most TTL-cached server-side) and keeps the contract simple.
//
// Debounced (300 ms) so a burst of cache invalidations from a single
// scheduler tick — e.g. job-watcher's 30-watchlist crawl emitting one Cache
// event per company — collapses into a single refetch wave instead of
// triggering N back-to-back invalidateQueries() calls.
const INVALIDATE_DEBOUNCE_MS = 300;

export function CacheInvalidationListener() {
    const queryClient = useQueryClient();
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const handleInvalidate = useCallback(() => {
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => {
            timerRef.current = null;
            queryClient.invalidateQueries();
        }, INVALIDATE_DEBOUNCE_MS);
    }, [queryClient]);

    useEffect(() => () => {
        if (timerRef.current) clearTimeout(timerRef.current);
    }, []);

    useServerEvents('Cache', handleInvalidate);
    return null;
}
