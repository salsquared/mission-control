import { z } from 'zod';

export const ResearchImportSchema = z.object({
    input: z.string().min(1).max(500),
});
