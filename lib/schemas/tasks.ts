import { z } from 'zod';

// ─── Entity shape ──────────────────────────────────────────────────────────
// Mirrors prisma.Task. Dates round-trip as ISO strings over JSON.
export const TaskSchema = z.object({
    id: z.string(),
    text: z.string(),
    status: z.enum(['TODO', 'IN_PROGRESS', 'DONE']),
    priority: z.enum(['BLOCKER', 'HIGH', 'MEDIUM', 'LOW']).nullable(),
    project: z.string().nullable(),
    dueDate: z.string().datetime().nullable(),
    position: z.number().int(),
    notes: z.string().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    parentId: z.string().nullable(),
});

// ─── Responses ─────────────────────────────────────────────────────────────
export const TasksListResponseSchema = z.object({
    tasks: z.array(TaskSchema),
});

export const TaskMutationResponseSchema = z.object({
    task: TaskSchema,
});

export const TaskCreateResponseSchema = z.object({
    success: z.literal(true),
    id: z.string(),
});

export const TaskDeleteResponseSchema = z.object({
    success: z.literal(true),
    id: z.string(),
});

// ─── Requests ──────────────────────────────────────────────────────────────
export const TaskPatchSchema = z.object({
    id: z.string().min(1),
    status: z.enum(['TODO', 'IN_PROGRESS', 'DONE']).optional(),
    text: z.string().min(1).optional(),
    dueDate: z.string().nullable().optional(),
    priority: z.enum(['BLOCKER', 'HIGH', 'MEDIUM', 'LOW']).nullable().optional(),
    position: z.number().int().optional(),
    parentId: z.string().nullable().optional(),
}).refine(
    (d) => d.status !== undefined
        || d.text !== undefined
        || d.dueDate !== undefined
        || d.priority !== undefined
        || d.position !== undefined
        || d.parentId !== undefined,
    { message: 'At least one mutable field must be provided' }
);

export const TaskPostSchema = z.object({
    text: z.string().min(1),
    parentId: z.string().optional(),
    isGoal: z.boolean().optional(),
});

export const TaskDeleteSchema = z.object({
    id: z.string().min(1),
});
