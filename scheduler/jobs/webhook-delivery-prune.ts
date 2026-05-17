/**
 * PA-2 (PB-6 audit follow-up): bound the growth of the Pub/Sub dedup table.
 *
 * `WebhookDelivery` rows are written by `app/api/gmail/webhook/route.ts` to
 * dedupe at-least-once Pub/Sub redeliveries. The table grows monotonically;
 * without retention it would carry every Gmail webhook fired since launch.
 *
 * Retention: 30 days. Pub/Sub's at-least-once window is ~7 days at the
 * extreme — anything older that's still delivering is a misconfiguration on
 * Google's end and we'd want to re-walk history.list for it anyway. 30 days
 * is conservative belt-and-suspenders.
 *
 * Exported for the scheduler. The smoke at scripts/tests/webhook-prune-smoke.ts
 * exercises this against dev.db with synthetic old rows.
 */
import { prisma } from "@/lib/prisma";

const RETENTION_DAYS = 30;

export interface WebhookPruneResult {
    deleted: number;
    cutoff: Date;
}

export async function runWebhookDeliveryPrune(): Promise<WebhookPruneResult> {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const res = await prisma.webhookDelivery.deleteMany({
        where: { receivedAt: { lt: cutoff } },
    });
    return { deleted: res.count, cutoff };
}
