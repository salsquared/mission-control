import type { ApiMeta } from '@/lib/api-docs/meta';

export const apiMeta: ApiMeta = {
  purpose: 'Server-Sent Events channel that streams DB-mutation events so connected clients (other tabs, phone, the Mac mini) can invalidate and refetch in real time.',
  external: [],
  notes: 'Broadcasts { model, action, id, timestamp } frames with 30s heartbeats.',
};
