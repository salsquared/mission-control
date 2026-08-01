import type { ApiMeta } from '@/lib/api-docs/meta';

export const apiMeta: ApiMeta = {
  purpose: 'Daily active-satellite count history (one point per UTC day) backing the Active Sats sparkline.',
  external: [],
  notes: 'Reads the cross-tier data/satellite-counts.db sidecar, which /api/space/satellites writes opportunistically on each successful Celestrak reading. Uncached — a local SQLite read of a once-a-day series. Returns an empty history rather than erroring when the sidecar is unavailable.',
};
