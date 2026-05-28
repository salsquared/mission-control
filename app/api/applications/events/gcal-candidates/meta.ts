import type { ApiMeta } from '@/lib/api-docs/meta';

export const apiMeta: ApiMeta = {
    purpose: "Lists upcoming Google Calendar events (next 90 days by default) that aren't already linked to a mission-control ApplicationEvent, for use by the adopt-existing-event flow.",
    external: ["Google Calendar API v3"],
};
