import { z } from 'zod';

export const TaskPatchSchema = z.object({
    id: z.string().min(1),
    status: z.enum(['TODO', 'IN_PROGRESS', 'DONE']).optional(),
    text: z.string().min(1).optional(),
    dueDate: z.string().nullable().optional(),
    priority: z.enum(['BLOCKER', 'HIGH', 'MEDIUM', 'LOW']).nullable().optional(),
}).refine(
    (d) => d.status !== undefined || d.text !== undefined || d.dueDate !== undefined || d.priority !== undefined,
    { message: 'At least one of status, text, dueDate, or priority must be provided' }
);

export const TaskPostSchema = z.object({
    text: z.string().min(1),
    parentId: z.string().optional(),
    isGoal: z.boolean().optional(),
});
