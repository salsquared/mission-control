import { google } from "googleapis";
import { getGoogleAuthClient } from "@/lib/googleapis";
import { prisma } from "@/lib/prisma";

/**
 * Registers (or renews) a Gmail push-notification watch for one user, pointing
 * Gmail at the Pub/Sub topic in GMAIL_PUBSUB_TOPIC. The webhook
 * (app/api/gmail/webhook/route.ts) receives the resulting pushes; this is the
 * registration half that was never wired up. Full design + GCP setup live in
 * docs/gmail-realtime-push.html.
 *
 * Invariants:
 *  - Gmail permits exactly ONE watch per mailbox and it expires after ~7 days,
 *    so scheduler/jobs/gmail-watch-renew.ts re-arms daily (and lib/auth.ts arms
 *    best-effort on sign-in).
 *  - The topic env var is SHARED across tiers (.env, not a tier file). dev and
 *    prod are linked to the same mailbox, so both re-arm the SAME topic
 *    idempotently rather than clobbering each other; the topic fans out to one
 *    push subscription per tier.
 *  - INBOX-scoped — application mail lands there; avoids label-change noise.
 *  - Seeds the webhook watermark (User.lastSyncedHistoryId) ONLY when null. On
 *    renewal the webhook owns it; overwriting with "now" would drop events
 *    between the last processed checkpoint and now.
 *  - No-ops (returns null) when GMAIL_PUBSUB_TOPIC is unset, so a tier without
 *    push configured never arms a real watch.
 */

const TOPIC = process.env.GMAIL_PUBSUB_TOPIC;

export interface GmailWatchResult {
    historyId: string;
    expiration: string;
}

export type RegisterGmailWatchFn = (userId: string) => Promise<GmailWatchResult | null>;

export const registerGmailWatch: RegisterGmailWatchFn = async (userId) => {
    if (!TOPIC) {
        console.warn("[gmail-watch] GMAIL_PUBSUB_TOPIC unset — skipping watch registration");
        return null;
    }

    const auth = await getGoogleAuthClient(userId);
    const gmail = google.gmail({ version: "v1", auth });
    const res = await gmail.users.watch({
        userId: "me",
        requestBody: {
            topicName: TOPIC,
            labelIds: ["INBOX"],
            labelFilterBehavior: "include",
        },
    });

    const historyId = res.data.historyId ? String(res.data.historyId) : "";
    const expiration = res.data.expiration ? String(res.data.expiration) : "";

    // Seed the per-user watermark only on first arm (see invariant above).
    if (historyId) {
        const u = await prisma.user.findUnique({
            where: { id: userId },
            select: { lastSyncedHistoryId: true },
        });
        if (u && !u.lastSyncedHistoryId) {
            await prisma.user.update({
                where: { id: userId },
                data: { lastSyncedHistoryId: historyId },
            });
        }
    }

    console.info(`[gmail-watch] armed user=${userId} historyId=${historyId} exp=${expiration}`);
    return { historyId, expiration };
};
