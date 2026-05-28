import type { ApiMeta } from '@/lib/api-docs/meta';

export const apiMeta: ApiMeta = {
  purpose: 'CRUD over the user\'s task list; the Task table is the sole source of truth.',
  external: [],
  notes: "Mutations broadcast { model: 'Task', action: 'upsert'|'delete' }. POST with isGoal auto-creates a child task.",
};
