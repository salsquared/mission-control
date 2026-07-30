import type { ApiMeta } from '@/lib/api-docs/meta';

export const apiMeta: ApiMeta = {
    purpose: "Lists the user's in-app notifications (with unread count) and marks them read/dismissed.",
    external: [],
    notes: "GET is NOT strictly createdAt-desc: up to 10 unread critical-tier rows are merged ahead of the recency window (deduped, still capped at `limit`), so a client must not assume a monotonic createdAt cursor. PATCH broadcasts { model: 'Notification', action: 'upsert' } when any row changes.",
};
