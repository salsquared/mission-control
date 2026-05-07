import { z } from 'zod';

// ─── Entity shape ──────────────────────────────────────────────────────────
export const GoalSchema = z.object({
    id: z.string(),
    text: z.string(),
    estimatedTime: z.string().nullable(),
    completed: z.boolean(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
});

// ─── Responses ─────────────────────────────────────────────────────────────
export const GoalsListResponseSchema = z.object({
    goals: z.array(GoalSchema),
});

export const GoalMutationResponseSchema = z.object({
    goal: GoalSchema,
});

export const GoalDeleteResponseSchema = z.object({
    success: z.literal(true),
});

// ─── Requests ──────────────────────────────────────────────────────────────
export const GoalPostSchema = z.object({
    text: z.string().min(1),
    estimatedTime: z.string().nullable().optional(),
});

export const GoalPatchSchema = z.object({
    id: z.string().min(1),
    completed: z.boolean(),
});

export const GoalDeleteSchema = z.object({
    id: z.string().min(1),
});
