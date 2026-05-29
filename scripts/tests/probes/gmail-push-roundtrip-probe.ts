/**
 * scripts/tests/probes/gmail-push-roundtrip-probe.ts
 *
 * Live END-TO-END probe for Gmail real-time push (docs/gmail-realtime-push.html §5,
 * first-light steps 3-5) — the one hop the receive-path probe can't cover.
 *
 * Sends a benign "please ignore" email FROM the linked account TO itself, so it
 * lands in the INBOX and trips the armed watch:
 *
 *     send -> Gmail -> Pub/Sub topic (gmail-push) -> BOTH push subscriptions
 *          -> prod webhook (:3101) + dev webhook (:4101) -> ingest
 *
 * Proof of success = a `[GMAIL WEBHOOK]` line appears in BOTH web-tier PM2 logs
 * within seconds (there have been zero such lines ever, so any line is new).
 *
 * Deliberately NOT application-shaped: the classifier's looksRelevant() pre-gate
 * skips it, so no junk Application row is created in either kanban. (The
 * classify+upsert path is covered by hermetic tests; this probe only exercises
 * the transport.) The only trace is the received mail itself (delete it) + a
 * WebhookDelivery row per tier (auto-pruned at 30d).
 *
 * Diagnostic only — exit-zero is NOT a contract. Reuses the pure RFC822 builders
 * from lib/email/send.ts and sends via the Gmail API directly, so it bypasses the
 * EMAIL_ENABLED gate (which only guards notification dispatch).
 *
 * Run (loads secrets from .env + DB url from .env.production):
 *   node --import tsx --env-file=.env --env-file=.env.production \
 *     scripts/tests/probes/gmail-push-roundtrip-probe.ts
 */
import { google } from "googleapis";
import { PrismaClient } from "@prisma/client";
import { getGoogleAuthClient } from "@/lib/googleapis";
import { buildRfc822Message, base64UrlEncode } from "@/lib/email/send";

const prisma = new PrismaClient();

async function main() {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    console.error("[ERR] GOOGLE_CLIENT_ID/SECRET not in env — run with --env-file=.env (see header).");
    process.exit(1);
  }

  const acct = await prisma.account.findFirst({
    where: { provider: "google", refresh_token: { not: null } },
    select: { userId: true },
  });
  if (!acct) {
    console.error("[ERR] No Google account with a refresh token in this DB. Pointed at the right one?");
    process.exit(1);
  }
  const user = await prisma.user.findUnique({
    where: { id: acct.userId },
    select: { email: true, name: true, lastSyncedHistoryId: true },
  });
  if (!user?.email) {
    console.error("[ERR] Linked user has no email address.");
    process.exit(1);
  }

  const stamp = new Date().toISOString();
  const msg = {
    from: `${user.name || "Mission Control"} <${user.email}>`,
    to: user.email,
    subject: `mission-control push test — please ignore (${stamp})`,
    text:
      `Automated Gmail real-time push plumbing test, sent ${stamp}.\n` +
      `This is NOT a job application — safe to delete.\n\n` +
      `If the watch + topic + subscriptions are live, a [GMAIL WEBHOOK] line\n` +
      `should appear in BOTH web-tier logs (mission-control + mission-control-dev)\n` +
      `within a few seconds of this arriving.\n`,
  };

  console.log(`Account:  ${user.email}  (lastSyncedHistoryId=${user.lastSyncedHistoryId ?? "null"})`);
  console.log(`Subject:  ${msg.subject}`);

  const auth = await getGoogleAuthClient(acct.userId);
  const gmail = google.gmail({ version: "v1", auth });
  const raw = base64UrlEncode(buildRfc822Message(msg));
  const res = await gmail.users.messages.send({ userId: "me", requestBody: { raw } });

  console.log(`\nSENT ✓  messageId=${res.data.id}  threadId=${res.data.threadId}`);
  console.log(
    `\nNow watch both web tiers for the push (any [GMAIL WEBHOOK] line is new):\n` +
    `  tail -f ~/.pm2/logs/mission-control-out.log ~/.pm2/logs/mission-control-dev-out.log | grep --line-buffered "GMAIL WEBHOOK"`,
  );

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("Unhandled:", e?.message ?? e);
  await prisma.$disconnect();
  process.exit(2);
});
