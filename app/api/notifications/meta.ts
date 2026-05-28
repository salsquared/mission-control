import type { ApiMeta } from '@/lib/api-docs/meta';

export const apiMeta: ApiMeta = {
    purpose: "Lists the user's in-app notifications (with unread count) and marks them read/dismissed.",
    external: [],
    notes: "PATCH broadcasts { model: 'Notification', action: 'upsert' } when any row changes.",
};
