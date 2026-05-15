import { z } from "zod";

export const NOTIFICATION_KINDS = ["posting", "application", "system"] as const;
export const NotificationKindSchema = z.enum(NOTIFICATION_KINDS);

export const NotificationSchema = z.object({
    id: z.string(),
    userId: z.string(),
    kind: NotificationKindSchema,
    title: z.string(),
    body: z.string().nullable(),
    payload: z.record(z.string(), z.unknown()),
    channels: z.string(), // comma-sep: "in_app[,email]"
    createdAt: z.string().datetime(),
    readAt: z.string().datetime().nullable(),
    dismissedAt: z.string().datetime().nullable(),
});

export type NotificationWire = z.infer<typeof NotificationSchema>;

// ─── Requests ──────────────────────────────────────────────────────────────

export const NotificationPatchSchema = z.union([
    z.object({ ids: z.array(z.string().min(1)).min(1), readAt: z.string().datetime().nullable() }),
    z.object({ ids: z.array(z.string().min(1)).min(1), dismissedAt: z.string().datetime().nullable() }),
    z.object({ markAllRead: z.literal(true) }),
]);

// ─── Responses ─────────────────────────────────────────────────────────────

export const NotificationsListResponseSchema = z.object({
    notifications: z.array(NotificationSchema),
    unreadCount: z.number().int(),
});

export const NotificationPatchResponseSchema = z.object({
    updated: z.number().int(),
});
