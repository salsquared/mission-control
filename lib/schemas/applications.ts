import { z } from 'zod';

// ─── Entity shape ──────────────────────────────────────────────────────────
// Mirrors prisma.Application.
export const ApplicationSchema = z.object({
    id: z.string(),
    userId: z.string(),
    company: z.string(),
    role: z.string().nullable(),
    status: z.string(),
    nextSteps: z.string().nullable(),
    dateApplied: z.string().datetime().nullable(),
    lastUpdateAt: z.string().datetime(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
});

// ─── Responses ─────────────────────────────────────────────────────────────
export const ApplicationsListResponseSchema = z.object({
    applications: z.array(ApplicationSchema),
});
