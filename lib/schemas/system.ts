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

// Per-host counts over the past hour. Drives the FetcherHealthCard.
const FetcherHealthEntrySchema = z.object({
    ok: z.number().int(),
    fallback: z.number().int(),
    broken: z.number().int(),
});
export const FetcherHealthResponseSchema = z.object({
    health: z.record(z.string(), FetcherHealthEntrySchema),
    computedAt: z.string(),
    note: z.string().optional(),
});
