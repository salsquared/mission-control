import { z } from 'zod';

// ─── ApplicationEmail ──────────────────────────────────────────────────────
export const ApplicationEmailSchema = z.object({
    id: z.string(),
    applicationId: z.string(),
    messageId: z.string(),
    threadId: z.string().nullable(),
    subject: z.string(),
    fromAddress: z.string(),
    receivedAt: z.string().datetime(),
    snippet: z.string().nullable(),
    parsedStatus: z.string().nullable(),
    createdAt: z.string().datetime(),
});

// ─── Entity shape ──────────────────────────────────────────────────────────
// Mirrors prisma.Application + recent linked emails.
export const ApplicationSchema = z.object({
    id: z.string(),
    userId: z.string(),
    company: z.string(),
    role: z.string().nullable(),
    status: z.string(),
    nextSteps: z.string().nullable(),
    nextStepAt: z.string().datetime().nullable(),
    dateApplied: z.string().datetime().nullable(),
    lastUpdateAt: z.string().datetime(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    emails: z.array(ApplicationEmailSchema),
});

// ─── Responses ─────────────────────────────────────────────────────────────
export const ApplicationsListResponseSchema = z.object({
    applications: z.array(ApplicationSchema),
});

// ─── Gmail watch ───────────────────────────────────────────────────────────
export const GmailWatchSchema = z.object({
    userId: z.string(),
    historyId: z.string(),
    expiresAt: z.string().datetime(),
    installedAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
});

export const GmailWatchResponseSchema = z.object({
    watch: GmailWatchSchema.nullable(),
});
