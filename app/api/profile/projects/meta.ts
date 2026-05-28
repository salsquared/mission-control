import type { ApiMeta } from '@/lib/api-docs/meta';

export const apiMeta: ApiMeta = {
    purpose: "Creates, updates, or deletes a project entry on the session user's CV profile.",
    external: [],
    notes: "Mutations broadcast { model: 'Profile', action: 'upsert'|'delete' }.",
};
