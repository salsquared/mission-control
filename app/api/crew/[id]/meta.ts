import type { ApiMeta } from '@/lib/api-docs/meta';

export const apiMeta: ApiMeta = {
  purpose: 'Owner-only removal of a crew account — deletes the User row, cascades all 18 relations, and sweeps that person\'s resume files off disk.',
  external: [],
  notes: 'Irreversible, no soft-delete. Requires a confirmEmail in the body that MUST match the target row\'s email, so a stale list cannot delete the wrong person. Refuses role="owner" via lib/crew/core.ts. Orphaned files are reported, not raised — the row is already gone.',
};
