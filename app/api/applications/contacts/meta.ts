import type { ApiMeta } from '@/lib/api-docs/meta';

export const apiMeta: ApiMeta = {
    purpose: "CRUD for the recruiter/contact rows attached to a given application (list by applicationId, create, update, delete).",
    external: [],
    notes: "Mutations broadcast Contact upsert/delete SSE events.",
};
