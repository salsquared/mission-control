import { z } from 'zod';

// Canonical status values — mirrors the LLM classifier enum in lib/email-parser.ts.
export const APPLICATION_STATUSES = [
    'APPLIED',
    'UPDATED',
    'ASSESSMENT',
    'INTERVIEW_REQUESTED',
    'INTERVIEW',
    'OFFER',
    'REJECTED',
] as const;
export const ApplicationStatusSchema = z.enum(APPLICATION_STATUSES);

// kind ≈ what the application is for. Null on legacy rows.
export const APPLICATION_KINDS = ['job', 'internship', 'college', 'other'] as const;
export const ApplicationKindSchema = z.enum(APPLICATION_KINDS);

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

export const ApplicationMutationResponseSchema = z.object({
    application: ApplicationSchema,
});

export const ApplicationDeleteResponseSchema = z.object({
    success: z.literal(true),
    id: z.string(),
});

// ─── Requests ──────────────────────────────────────────────────────────────
export const ApplicationPostSchema = z.object({
    company: z.string().min(1),
    role: z.string().min(1).nullable().optional(),
    status: ApplicationStatusSchema.default('APPLIED'),
    kind: ApplicationKindSchema.nullable().optional(),
    nextSteps: z.string().nullable().optional(),
    dateApplied: z.string().datetime().nullable().optional(),
});

export const ApplicationPatchSchema = z.object({
    id: z.string().min(1),
    company: z.string().min(1).optional(),
    role: z.string().nullable().optional(),
    status: ApplicationStatusSchema.optional(),
    kind: ApplicationKindSchema.nullable().optional(),
    nextSteps: z.string().nullable().optional(),
    dateApplied: z.string().datetime().nullable().optional(),
}).refine(
    (d) => d.company !== undefined
        || d.role !== undefined
        || d.status !== undefined
        || d.kind !== undefined
        || d.nextSteps !== undefined
        || d.dateApplied !== undefined,
    { message: 'At least one mutable field must be provided' }
);

export const ApplicationDeleteSchema = z.object({
    id: z.string().min(1),
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
