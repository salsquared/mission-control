import { google } from "googleapis";
import { getGoogleAuthClient } from "@/lib/googleapis";
import {
    findGmailWatch,
    upsertGmailWatch,
} from "@/lib/repositories/gmail-watches";
import type { GmailWatch } from "@prisma/client";

const RENEW_THRESHOLD_MS = 48 * 60 * 60 * 1000; // renew when <48h left
const DEFAULT_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

export async function installGmailWatch(userId: string): Promise<GmailWatch> {
    const topic = process.env.GMAIL_PUBSUB_TOPIC;
    if (!topic) {
        throw new Error("GMAIL_PUBSUB_TOPIC not configured");
    }

    const authClient = await getGoogleAuthClient(userId);
    const gmail = google.gmail({ version: "v1", auth: authClient });

    const res = await gmail.users.watch({
        userId: "me",
        requestBody: {
            topicName: topic,
            labelIds: ["INBOX"],
            labelFilterBehavior: "INCLUDE",
        },
    });

    const historyId = res.data.historyId ?? "0";
    const expirationMs = res.data.expiration
        ? Number(res.data.expiration)
        : Date.now() + DEFAULT_EXPIRY_MS;

    return upsertGmailWatch({
        userId,
        historyId: String(historyId),
        expiresAt: new Date(expirationMs),
    });
}

/**
 * Best-effort lazy renewal. Called from `GET /api/applications` so an active
 * user keeps their watch alive without us running a scheduler. Failures are
 * swallowed — the caller is a read endpoint and shouldn't fail just because
 * Pub/Sub is unhappy.
 */
export async function ensureGmailWatchFresh(userId: string): Promise<void> {
    if (!process.env.GMAIL_PUBSUB_TOPIC) return;
    try {
        const existing = await findGmailWatch(userId);
        const needsInstall =
            !existing || existing.expiresAt.getTime() - Date.now() < RENEW_THRESHOLD_MS;
        if (needsInstall) {
            await installGmailWatch(userId);
        }
    } catch (e: any) {
        console.warn(`[GMAIL WATCH] lazy renewal failed for user ${userId}: ${e.message}`);
    }
}
