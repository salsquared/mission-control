import { z } from 'zod';

// Operator-triggered cache invalidation. Either a single key (exact match) or
// a prefix; if both are present, key wins.
export const CacheInvalidatePostSchema = z.object({
    key: z.string().min(1).optional(),
    prefix: z.string().min(1).optional(),
}).refine(d => d.key !== undefined || d.prefix !== undefined, {
    message: 'Either key or prefix is required',
});

export const CacheInvalidateResponseSchema = z.object({
    success: z.literal(true),
    invalidated: z.number().int(),
});
