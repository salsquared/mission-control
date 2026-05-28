import type { ApiMeta } from '@/lib/api-docs/meta';

export const apiMeta: ApiMeta = {
    purpose: "Reads a single tracked job posting and updates its status (e.g. open/closed/dismissed).",
    external: [],
    notes: "PATCH broadcasts { model: 'Posting', action: 'upsert' } over SSE.",
};
