import { z } from 'zod';

export const SavedPaperPostSchema = z.object({
    paperId: z.string().min(1),
    title: z.string().optional(),
    summary: z.string().optional(),
    url: z.string().url().optional(),
    authors: z.string().optional(),
    publishedAt: z.string().datetime().optional(),
    topic: z.string().min(1),
    status: z.string().min(1),
});

// DELETE comes through as a query param (?paperId=...) rather than a JSON body.
export const SavedPaperDeleteQuerySchema = z.object({
    paperId: z.string().min(1),
});

export const SavedPaperListQuerySchema = z.object({
    topic: z.string().nullable().optional(),
    status: z.string().nullable().optional(),
});
