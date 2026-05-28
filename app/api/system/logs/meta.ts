import type { ApiMeta } from '@/lib/api-docs/meta';

export const apiMeta: ApiMeta = {
  purpose: 'Streams server logs over Server-Sent Events — an initial snapshot frame on connect, then one frame per new log line.',
  external: [],
  notes: 'Reads the in-memory log ring buffer (lib/logger.ts); 10s ping comments keep the connection alive.',
};
