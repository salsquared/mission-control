"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { CacheInvalidationListener } from "./CacheInvalidationListener";

// One QueryClient per browser tab. Defaults are tuned for this app's posture:
//   - Stale-while-revalidate is owned server-side by withCache, so client-side
//     staleTime is short — TanStack just dedupes concurrent requests and
//     waits for SSE invalidations to refetch.
//   - retry is off because failures already STALE-FALLBACK from withCache and
//     the toast pipeline surfaces the issue.
export function QueryProvider({ children }: { children: React.ReactNode }) {
    const [client] = useState(() => new QueryClient({
        defaultOptions: {
            queries: {
                staleTime: 30_000,
                retry: false,
                refetchOnWindowFocus: true,
            },
        },
    }));

    return (
        <QueryClientProvider client={client}>
            <CacheInvalidationListener />
            {children}
        </QueryClientProvider>
    );
}
