"use client";

import { useCallback } from "react";
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
export function CacheInvalidationListener() {
    const queryClient = useQueryClient();
    const handleInvalidate = useCallback(() => {
        queryClient.invalidateQueries();
    }, [queryClient]);
    useServerEvents('Cache', handleInvalidate);
    return null;
}
