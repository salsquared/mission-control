import { z } from 'zod';

// ─── Entity shape ──────────────────────────────────────────────────────────
// Mirrors prisma.Application.
export const ApplicationSchema = z.object({
    id: z.string(),
    userId: z.string(),
    company: z.string(),
    role: z.string().nullable(),
    status: z.string(),
    kind: z.string().nullable(),
    nextSteps: z.string().nullable(),
    dateApplied: z.string().datetime().nullable(),
    lastEmailMsgId: z.string().nullable(),
    lastUpdateAt: z.string().datetime(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
});

// ─── Responses ─────────────────────────────────────────────────────────────
export const ApplicationsListResponseSchema = z.object({
    applications: z.array(ApplicationSchema),
});

// ─── Backfill ──────────────────────────────────────────────────────────────
export const BackfillRequestSchema = z.object({
    days: z.number().int().min(1).max(365 * 3).optional(),
    max: z.number().int().min(1).max(1000).optional(),
});

export const BackfillResponseSchema = z.object({
    scanned: z.number().int(),
    classified: z.number().int(),
    created: z.number().int(),
    updated: z.number().int(),
    skipped: z.number().int(),
    errored: z.number().int(),
    durationMs: z.number().int(),
    truncated: z.boolean(),
});
