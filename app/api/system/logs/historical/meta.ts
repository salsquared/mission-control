import type { ApiMeta } from '@/lib/api-docs/meta';

export const apiMeta: ApiMeta = {
  purpose: 'Reads the on-disk PM2 log file, parses its JSON-lines entries, applies optional time-range and level filters, and returns up to the most recent 1000 matches.',
  external: [],
  notes: 'Reads ~/.pm2/logs/mission-control-out.log (overridable via PM2_LOG_PATH); non-JSON lines are skipped.',
};
