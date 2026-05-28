import type { ApiMeta } from '@/lib/api-docs/meta';

export const apiMeta: ApiMeta = {
    purpose: "Lists the session user's profile snapshots (id, takenAt, label) or captures a new point-in-time snapshot of their current profile.",
    external: [],
    notes: "POST broadcasts { model: 'ProfileSnapshot', action: 'upsert' }.",
};
