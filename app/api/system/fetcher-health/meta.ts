import type { ApiMeta } from '@/lib/api-docs/meta';

export const apiMeta: ApiMeta = {
  purpose: 'Parses the PM2 log file for cache/external-API/scraper log lines and aggregates per-upstream-host ok/fallback/broken counts over 1h/6h/1d windows for the Fetcher Health card.',
  external: [],
  notes: 'Reads the per-tier PM2 out.log (dev vs prod chosen by NODE_ENV; overridable via PM2_LOG_PATH).',
};
