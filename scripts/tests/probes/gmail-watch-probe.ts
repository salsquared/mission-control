/**
 * Live probe for Gmail push-watch registration. Calls registerGmailWatch
 * against the real account and prints what Gmail returned — use for first-light
 * verification once the GCP side (topic + subscriptions + GMAIL_PUBSUB_TOPIC)
 * is configured per docs/archive/gmail-realtime-push.html.
 *
 * Diagnostic only — exit-zero is NOT a contract. With GMAIL_PUBSUB_TOPIC unset
 * this no-ops (prints the skip) and is harmless; with it set it ARMS a real
 * watch on the mailbox (which is the intended, idempotent daily action).
 *
 * Usage (dev account):
 *   DATABASE_URL="file:./dev.db" npx tsx scripts/tests/probes/gmail-watch-probe.ts
 * (prod account):
 *   DATABASE_URL="file:./prod.db" npx tsx scripts/tests/probes/gmail-watch-probe.ts
 */
import { PrismaClient } from "@prisma/client";
import { registerGmailWatch } from "@/lib/gmail/watch";

const prisma = new PrismaClient();

async function main() {
    console.log(`GMAIL_PUBSUB_TOPIC=${process.env.GMAIL_PUBSUB_TOPIC ?? "(unset — registerGmailWatch will no-op)"}`);

    const user = await prisma.user.findFirst({ select: { id: true, email: true, lastSyncedHistoryId: true } });
    if (!user) {
        console.error("[ERR] No User row in DB. Are you pointed at the right DB?");
        process.exit(1);
    }
    console.log(`User: ${user.email} (${user.id})  lastSyncedHistoryId=${user.lastSyncedHistoryId ?? "null"}`);

    try {
        const result = await registerGmailWatch(user.id);
        if (!result) {
            console.log("→ no-op (topic unset). Set GMAIL_PUBSUB_TOPIC and re-run to arm.");
        } else {
            console.log(`→ armed: historyId=${result.historyId} expiration=${result.expiration}`);
            const exp = Number(result.expiration);
            if (exp) console.log(`  expires ~${new Date(exp).toISOString()} (~${Math.round((exp - Date.now()) / 3600000)}h)`);
            const after = await prisma.user.findUnique({ where: { id: user.id }, select: { lastSyncedHistoryId: true } });
            console.log(`  lastSyncedHistoryId now: ${after?.lastSyncedHistoryId ?? "null"}`);
        }
    } catch (e: any) {
        console.error(`[ERR] registerGmailWatch threw: ${e?.message ?? e}`);
        console.error("  → Likely the account is missing a refresh token, the topic name is wrong, or Gmail lacks publish rights on the topic.");
    }

    await prisma.$disconnect();
}

main().catch(async (e) => {
    console.error("Unhandled:", e);
    await prisma.$disconnect();
    process.exit(2);
});
