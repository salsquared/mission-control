import type { ApiMeta } from '@/lib/api-docs/meta';

export const apiMeta: ApiMeta = {
    purpose: "Moves multiple applications between kanban tracks in one atomic transaction, returning the count of rows that changed or 409 with conflicting pairs.",
    external: [],
    notes: "Broadcasts one Application upsert SSE event per moved row so per-track caches invalidate.",
};
