import type { ApiMeta } from '@/lib/api-docs/meta';

export const apiMeta: ApiMeta = {
  purpose: 'Active-satellite counts for Earth-centric orbits, categorized by orbit type (LEO, MEO, GEO, SSO) and notable constellations (Starlink, OneWeb).',
  external: ['Celestrak GP Data'],
  notes: 'Celestrak returns 403 ("GP data has not updated…") on unchanged re-requests; the route throws so withCache serves the stale entry instead of a 500.',
};
