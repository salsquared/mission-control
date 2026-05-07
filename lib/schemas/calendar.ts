import { z } from 'zod';

// ─── Entity shape ──────────────────────────────────────────────────────────
// Subset of Google Calendar's Event shape that the UI actually reads.
// Permissive (passthrough) — Google sends many more fields than we model.
export const CalendarEventSchema = z.object({
    id: z.string(),
    summary: z.string().optional(),
    description: z.string().optional(),
    start: z.object({
        dateTime: z.string().optional(),
        timeZone: z.string().optional(),
    }).optional(),
    end: z.object({
        dateTime: z.string().optional(),
        timeZone: z.string().optional(),
    }).optional(),
}).passthrough();

// ─── Responses ─────────────────────────────────────────────────────────────
export const CalendarEventListResponseSchema = z.object({
    events: z.array(CalendarEventSchema).nullable().optional(),
});

export const CalendarEventMutationResponseSchema = z.object({
    event: CalendarEventSchema,
});

export const CalendarEventDeleteResponseSchema = z.object({
    success: z.literal(true),
});

// ─── Requests ──────────────────────────────────────────────────────────────
export const CalendarEventPostSchema = z.object({
    eventId: z.string().optional(),
    summary: z.string().min(1),
    description: z.string().optional(),
    start: z.string().datetime(),
    end: z.string().datetime(),
});
