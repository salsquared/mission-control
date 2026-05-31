import { z } from 'zod';

// Canonical status values — mirrors the LLM classifier enum in lib/email-parser.ts.
// INTERESTED is the pre-applied state (story S5.5): a posting tracked from the
// watchlist feed but not yet sent. Living before APPLIED keeps the kanban order
// chronological from interest → applied → ... → outcome.
export const APPLICATION_STATUSES = [
    'INTERESTED',
    'APPLIED',
    'UPDATED',
    'ASSESSMENT',
    'INTERVIEW_REQUESTED',
    'INTERVIEW',
    'OFFER',
    'ACCEPTED',
    'DECLINED',
    'REJECTED',
] as const;
export const ApplicationStatusSchema = z.enum(APPLICATION_STATUSES);

// kind ≈ what the application is for. Null on legacy rows.
export const APPLICATION_KINDS = ['job', 'internship', 'college', 'other'] as const;
export const ApplicationKindSchema = z.enum(APPLICATION_KINDS);

// MB Phase 4 — orthogonal to kind. "career" = long-term professional pursuit
// (the main kanban); "side" = gig / blue-collar / pay-the-bills work shown in
// the segregated Side Pipeline.
//
// 2026-05-27: dropped the schema-level `.default('career')` on POST/entity
// shapes. Track is now explicit on every create site — see
// ApplicationCreate.track in lib/repositories/applications.ts for the
// rationale (a silent fallback masked the cross-track dedup bug). The
// AddApplicationModal always sends track from its `defaultTrack` prop
// (career vs side, picked by which kanban opened it), so removing the Zod
// default just turns the UI invariant into a 400 if it ever regresses.
export const APPLICATION_TRACKS = ['career', 'side'] as const;
export const ApplicationTrackSchema = z.enum(APPLICATION_TRACKS);

// ─── Entity shape ──────────────────────────────────────────────────────────
// Mirrors prisma.Application.
export const ApplicationSchema = z.object({
    id: z.string(),
    userId: z.string(),
    company: z.string(),
    role: z.string().nullable(),
    status: z.string(),
    kind: z.string().nullable(),
    track: ApplicationTrackSchema,
    nextSteps: z.string().nullable(),
    dateApplied: z.string().datetime().nullable(),
    decisionDeadline: z.string().datetime().nullable(),
    lastEmailMsgId: z.string().nullable(),
    postingId: z.string().nullable(),
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

// Story S13.8 — bulk move N applications between tracks in one round-trip.
// The same-employer-both-tracks constraint (@@unique([userId, normalizedCompany, track]))
// means a bulk move can hit P2002 if a moved row's normalizedCompany already
// exists in the target track. The 409 response carries the conflicting ids
// so the UI can surface them without a second round-trip.
export const ApplicationBulkTrackSchema = z.object({
    ids: z.array(z.string().min(1)).min(1).max(200),
    track: ApplicationTrackSchema,
});

export const ApplicationBulkTrackResponseSchema = z.object({
    updated: z.number().int().nonnegative(),
    ids: z.array(z.string()),
});

export const ApplicationBulkTrackConflictSchema = z.object({
    error: z.literal('conflict'),
    conflicts: z.array(z.object({
        id: z.string(),
        normalizedCompany: z.string().nullable(),
        company: z.string(),
        existingId: z.string(),
    })),
});

// ─── Requests ──────────────────────────────────────────────────────────────
export const ApplicationPostSchema = z.object({
    company: z.string().min(1),
    role: z.string().min(1).nullable().optional(),
    status: ApplicationStatusSchema.default('APPLIED'),
    kind: ApplicationKindSchema.nullable().optional(),
    track: ApplicationTrackSchema,
    nextSteps: z.string().nullable().optional(),
    dateApplied: z.string().datetime().nullable().optional(),
    decisionDeadline: z.string().datetime().nullable().optional(),
});

export const ApplicationPatchSchema = z.object({
    id: z.string().min(1),
    company: z.string().min(1).optional(),
    role: z.string().nullable().optional(),
    status: ApplicationStatusSchema.optional(),
    kind: ApplicationKindSchema.nullable().optional(),
    track: ApplicationTrackSchema.optional(),
    nextSteps: z.string().nullable().optional(),
    dateApplied: z.string().datetime().nullable().optional(),
    decisionDeadline: z.string().datetime().nullable().optional(),
    // §6 Q4 — manual canon tag (null clears it).
    canonId: z.string().cuid().nullable().optional(),
}).refine(
    (d) => d.company !== undefined
        || d.role !== undefined
        || d.status !== undefined
        || d.kind !== undefined
        || d.track !== undefined
        || d.nextSteps !== undefined
        || d.dateApplied !== undefined
        || d.decisionDeadline !== undefined
        || d.canonId !== undefined,
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
