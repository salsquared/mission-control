/**
 * Daily Gmail push-watch renewal. Gmail watch subscriptions expire after ~7
 * days; this re-arms every Google-linked user's watch so real-time ingestion
 * never goes silent. Daily cadence = ~7x safety margin; the 10s startup
 * stagger in scheduler/index.ts also self-heals the watch within seconds of
 * any scheduler restart.
 *
 * Stateless sweep (no schema state). Idempotent — re-arming points at the same
 * shared topic, so running it in both tiers is safe (see lib/gmail/watch.ts +
 * docs/archive/gmail-realtime-push.html).
 *
 * `register` is injectable so the hermetic smoke can exercise account selection
 * + per-user error isolation without touching the live Gmail API.
 */
import { prisma } from "@/lib/prisma";
import { registerGmailWatch, type RegisterGmailWatchFn } from "@/lib/gmail/watch";

export interface GmailWatchRenewResult {
    processed: number;
    renewed: number;
    failed: number;
}

export async function runGmailWatchRenew(
    register: RegisterGmailWatchFn = registerGmailWatch,
): Promise<GmailWatchRenewResult> {
    const accounts = await prisma.account.findMany({
        where: { provider: "google", refresh_token: { not: null } },
        select: { userId: true },
    });
    const userIds = [...new Set(accounts.map((a) => a.userId))];

    let renewed = 0;
    let failed = 0;
    for (const userId of userIds) {
        try {
            if (await register(userId)) renewed++;
        } catch (e) {
            failed++;
            console.warn(`[gmail-watch-renew] failed for user ${userId}:`, (e as Error)?.message ?? e);
        }
    }

    return { processed: userIds.length, renewed, failed };
}
