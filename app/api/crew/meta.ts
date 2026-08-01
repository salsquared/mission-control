import type { ApiMeta } from '@/lib/api-docs/meta';

export const apiMeta: ApiMeta = {
  purpose: 'Owner-only crew roster — lists every account with its current AI/watchlist/application usage, and provisions a new role="crew" account by email.',
  external: [],
  notes: 'Second production user.create path; shares lib/crew/core.ts with scripts/manage-crew.ts so neither can mint an owner. POST accepts an email ONLY — there is no role parameter by design. Counters are three grouped queries, not per-row.',
};
