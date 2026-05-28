import type { ApiMeta } from '@/lib/api-docs/meta';

export const apiMeta: ApiMeta = {
    purpose: "Adopts an existing Google Calendar event into an application by creating a mirroring ApplicationEvent row and tagging the Gcal event with mission-control extendedProperties so future syncs recognize ownership.",
    external: ["Google Calendar API v3"],
    notes: "Rejects re-adopting an already-linked event with 409; broadcasts a CalendarEvent upsert SSE event.",
};
