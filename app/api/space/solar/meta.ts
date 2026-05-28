import type { ApiMeta } from '@/lib/api-docs/meta';

export const apiMeta: ApiMeta = {
  purpose: 'Reports current solar activity (latest GOES primary X-ray flux) categorized into a status level (Normal/Moderate/High/Extreme).',
  external: ['NOAA SWPC'],
};
