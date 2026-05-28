import type { ApiMeta } from '@/lib/api-docs/meta';

export const apiMeta: ApiMeta = {
  purpose: 'Real-time process and system telemetry: CPU usage, RSS memory vs. the --max-old-space-size limit, uptime, DB connectivity, Pulsar reachability, and withCache hit/miss/key stats.',
  external: [],
  notes: 'Pings ${PULSAR_URL}/api/prices/latest with a 2s timeout for liveness only.',
};
