import type { ApiMeta } from '@/lib/api-docs/meta';

export const apiMeta: ApiMeta = {
    purpose: "CRUD for LifeGoal rows.",
    external: [],
    notes: "Each mutation broadcasts { model: 'Goal', action: 'upsert'|'delete' }.",
};
