import { z } from 'zod';

export const CalendarEventPostSchema = z.object({
    eventId: z.string().optional(),
    summary: z.string().min(1),
    description: z.string().optional(),
    start: z.string().datetime(),
    end: z.string().datetime(),
});
