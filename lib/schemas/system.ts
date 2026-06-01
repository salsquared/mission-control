import { z } from 'zod';

// ─── Sub-shapes ────────────────────────────────────────────────────────────
const CacheStatsSchema = z.object({
    hits: z.number().int(),
    misses: z.number().int(),
    activeEntries: z.array(z.object({
        key: z.string(),
        remainingTtl: z.number().int(),
    })),
});

// ─── Response ──────────────────────────────────────────────────────────────
// Shape returned by GET /api/system. Drives the InternalView telemetry tile.
export const SystemTelemetryResponseSchema = z.object({
    cpuUsagePercent: z.number(),
    memoryUsageFormatted: z.string(),
    maxAllocatedRamGB: z.number(),
    uptimeFormatted: z.string(),
    dbConnected: z.boolean(),
    pulsarOnline: z.boolean(),
    cache: CacheStatsSchema,
});

// Per-host outcome counts over the selected window. Drives the FetcherHealthCard.
// `error` = upstream returned non-2xx or the request threw (a 500 is an error,
// not an ok) — recorded from the real loggedFetch response. See
// docs/archive/fetcher-health-store.html.
const FetcherHealthEntrySchema = z.object({
    ok: z.number().int(),
    error: z.number().int(),
    fallback: z.number().int(),
    broken: z.number().int(),
});
export const FetcherHealthResponseSchema = z.object({
    health: z.record(z.string(), FetcherHealthEntrySchema),
    totals: z.object({
        '1h': FetcherHealthEntrySchema,
        '6h': FetcherHealthEntrySchema,
        '1d': FetcherHealthEntrySchema,
    }).optional(),
    computedAt: z.string(),
    note: z.string().optional(),
});
