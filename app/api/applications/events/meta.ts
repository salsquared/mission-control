import type { ApiMeta } from '@/lib/api-docs/meta';

export const apiMeta: ApiMeta = {
    purpose: "Read and manage ApplicationEvent timeline entries (interviews/offers/etc.) for the signed-in user; create/update/delete mirror the change into Google Calendar.",
    external: ["Google Calendar API v3"],
    notes: "Mutations sync to Gcal and broadcast CalendarEvent SSE events; `kind` is intentionally not patchable.",
};
