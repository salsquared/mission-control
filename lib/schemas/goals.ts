import { z } from 'zod';

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
