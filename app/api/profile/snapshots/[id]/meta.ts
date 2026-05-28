import type { ApiMeta } from '@/lib/api-docs/meta';

export const apiMeta: ApiMeta = {
    purpose: "Reads the full hydrated payload of one profile snapshot or deletes it, owner-scoped by session.",
    external: [],
    notes: "DELETE broadcasts { model: 'ProfileSnapshot', action: 'delete' }.",
};
