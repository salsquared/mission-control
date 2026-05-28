import type { ApiMeta } from '@/lib/api-docs/meta';

export const apiMeta: ApiMeta = {
    purpose: "Manages the user's saved research paper library — listing, upserting (with read status/topic), and deleting tracked papers.",
    external: [],
    notes: "Mutations broadcast { model: 'SavedPaper', action: 'upsert'|'delete' } over the SSE event stream.",
};
