import type { ApiMeta } from '@/lib/api-docs/meta';

export const apiMeta: ApiMeta = {
  purpose: "Provides a weekly calendar of the moon's cycles and highlights upcoming global lunar phenomena (supermoons, lunar eclipses).",
  external: [],
  notes: 'Pure local computation — algorithmic phase calculation + a hardcoded LUNAR_PHENOMENA table. No upstreamHost, so intentionally absent from the Fetcher Health card.',
};
