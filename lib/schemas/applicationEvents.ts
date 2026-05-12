import { z } from 'zod';

export const APPLICATION_EVENT_KINDS = [
    'APPLIED',
    'STATUS_CHANGED',
    'EMAIL_RECEIVED',
    'ASSESSMENT_REQUESTED',
    'INTERVIEW_SCHEDULED',
    'OFFER',
    'REJECTION',
    'NOTE',
] as const;

export const ApplicationEventKindSchema = z.enum(APPLICATION_EVENT_KINDS);

// ─── Entity shape ──────────────────────────────────────────────────────────
export const ApplicationEventSchema = z.object({
    id: z.string(),
    applicationId: z.string(),
    kind: ApplicationEventKindSchema,
    title: z.string(),
    occurredAt: z.string().datetime(),
    scheduledAt: z.string().datetime().nullable(),
    endsAt: z.string().datetime().nullable(),
    fromStatus: z.string().nullable(),
    toStatus: z.string().nullable(),
    notes: z.string().nullable(),
    emailMsgId: z.string().nullable(),
    gcalEventId: z.string().nullable(),
    gcalUpdatedAt: z.string().datetime().nullable(),
    syncSource: z.enum(['ms', 'gcal']).nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    // Hydrated from the included Application — UI shows company/role next to
    // each timeline row without needing a second query.
    application: z
        .object({
            company: z.string(),
            role: z.string().nullable(),
        })
        .optional(),
});

// ─── Responses ─────────────────────────────────────────────────────────────
export const ApplicationEventsListResponseSchema = z.object({
    events: z.array(ApplicationEventSchema),
});

export const ApplicationEventMutationResponseSchema = z.object({
    event: ApplicationEventSchema,
});

export const ApplicationEventDeleteResponseSchema = z.object({
    success: z.literal(true),
});

// ─── Requests ──────────────────────────────────────────────────────────────
export const ApplicationEventPostSchema = z.object({
    applicationId: z.string().min(1),
    kind: ApplicationEventKindSchema,
    title: z.string().min(1),
    occurredAt: z.string().datetime().optional(),
    scheduledAt: z.string().datetime().optional(),
    endsAt: z.string().datetime().optional(),
    notes: z.string().optional(),
});

export const ApplicationEventSyncResponseSchema = z.object({
    applied: z.number().int(),
    deleted: z.number().int(),
    reset: z.boolean(),
});

export const GcalCandidateSchema = z.object({
    gcalEventId: z.string(),
    summary: z.string(),
    scheduledAt: z.string().datetime(),
    endsAt: z.string().datetime().nullable(),
    description: z.string().nullable(),
});

export const GcalCandidatesResponseSchema = z.object({
    candidates: z.array(GcalCandidateSchema),
});

export const ApplicationEventAdoptPostSchema = z.object({
    applicationId: z.string().min(1),
    gcalEventId: z.string().min(1),
    kind: ApplicationEventKindSchema,
    title: z.string().optional(),
});

export const ApplicationEventPatchSchema = z.object({
    id: z.string().min(1),
    title: z.string().min(1).optional(),
    scheduledAt: z.string().datetime().nullable().optional(),
    endsAt: z.string().datetime().nullable().optional(),
    notes: z.string().nullable().optional(),
    kind: ApplicationEventKindSchema.optional(),
});
