import type { ApiMeta } from '@/lib/api-docs/meta';

export const apiMeta: ApiMeta = {
  purpose: 'Reads and writes the single-row GlobalSetting table that backs cross-device prefs (dark mode, view hues, dash order/titles), with optimistic-concurrency versioning on writes.',
  external: [],
  notes: 'POST requires an If-Match header carrying the last-seen version; a mismatch returns 409 with the current version.',
};
