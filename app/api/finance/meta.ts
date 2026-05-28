import type { ApiMeta } from '@/lib/api-docs/meta';

export const apiMeta: ApiMeta = {
  purpose: 'Fetches latest crypto prices + the filtered top-100 list and current Bitcoin recommended fees, all sourced from the local Pulsar ingestion service.',
  external: ['Pulsar (PULSAR_URL)'],
  notes: 'Filters known spam/stable/RWA tokens via SPAM_COIN_IDS and BTC fee-tier ids via BTC_FEE_IDS. Cache upstreamHost is derived from PULSAR_URL at request time.',
};
