import type { ApiMeta } from '@/lib/api-docs/meta';

export const apiMeta: ApiMeta = {
  purpose: 'OIDC-verified endpoint that Google Pub/Sub pushes Gmail history notifications to; new messages classifying as application/interview correspondence upsert an Application row.',
  external: ['Gmail API v1', 'Google Pub/Sub (OIDC)', 'Gemini'],
  notes: "First action on every envelope is INSERT OR IGNORE on WebhookDelivery(messageId) — P2002 → 200 deduped. Idempotent ingest via per-event notifiedAt/gcalSyncedAt checkpoints. Broadcasts { model: 'Application', action: 'upsert' }.",
};
