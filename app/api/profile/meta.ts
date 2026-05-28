import type { ApiMeta } from '@/lib/api-docs/meta';

export const apiMeta: ApiMeta = {
    purpose: "Reads the session user's full CV profile (creating an empty one if none exists) or patches its header fields (headline, location, contact, links, tagline).",
    external: [],
    notes: "PATCH broadcasts { model: 'Profile', action: 'upsert' }.",
};
