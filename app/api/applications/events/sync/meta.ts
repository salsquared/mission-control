import type { ApiMeta } from '@/lib/api-docs/meta';

export const apiMeta: ApiMeta = {
    purpose: "Manually pulls Google Calendar changes for the signed-in user into their ApplicationEvent rows via Google's syncToken.",
    external: ["Google Calendar API v3"],
    notes: "Broadcasts a CalendarEvent invalidate SSE event when any rows are applied or deleted.",
};
