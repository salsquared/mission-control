import type { ApiMeta } from '@/lib/api-docs/meta';

export const apiMeta: ApiMeta = {
  purpose: 'Returns a historical price series for a coin — hourly OHLCV bars for short ranges (<=30 days), pre-aggregated daily summaries downsampled to ~500 points for longer ranges or "max".',
  external: ['Pulsar (PULSAR_URL)'],
};
