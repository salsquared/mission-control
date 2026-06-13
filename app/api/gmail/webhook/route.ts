import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getGoogleAuthClient } from "@/lib/googleapis";
import { google } from "googleapis";
import { PubSubEnvelopeSchema, PubSubPayloadSchema } from "@/lib/schemas/gmail-webhook";
import { findUserByEmailWithAccounts } from "@/lib/repositories/users";
import { ingestGmailMessage } from "@/lib/applications/ingest";
import { recordFailedIngest, clearFailedIngest } from "@/lib/applications/failed-ingest";
import { verifyPubSubOIDC } from "@/lib/google-oidc";
import { isStaleHistoryError } from "@/lib/gmail/history-errors";

// Pin to Node runtime — this route uses googleapis + jose, both of which pull
// in `node:*` imports (notably undici → node:assert) that the edge runtime
// can't handle. serverExternalPackages in next.config also keeps them out of
// the webpack bundle; this export is belt-and-suspenders.
export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const audience = process.env.PUBSUB_AUDIENCE;
  if (!audience) {
    console.error("[GMAIL WEBHOOK] PUBSUB_AUDIENCE not configured");
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }
  // RAH-10: verifyPubSubOIDC only validates issuer + audience + signature, so
  // ANY Google-signed OIDC token with the right `aud` would pass — and the
  // audience (the webhook URL) is not secret. Assert the signer's service-
  // account email matches the env-configured one + email_verified is true.
  // When PUBSUB_SERVICE_ACCOUNT_EMAIL is unset we keep the old behavior (just
  // log a warning) so existing deployments don't break before the env var is
  // populated; set it in `.env` after step 1 of docs/hosting.md.
  const expectedSignerEmail = process.env.PUBSUB_SERVICE_ACCOUNT_EMAIL;
  try {
    const claims = await verifyPubSubOIDC(req, audience);
    if (expectedSignerEmail) {
      if (claims.email !== expectedSignerEmail || claims.email_verified !== true) {
        console.warn(`[GMAIL WEBHOOK] signer identity mismatch: got ${claims.email} (verified=${claims.email_verified}), expected ${expectedSignerEmail}`);
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
    } else {
      console.warn("[GMAIL WEBHOOK] PUBSUB_SERVICE_ACCOUNT_EMAIL not set — accepting any Google-signed token (RAH-10 not yet enforced)");
    }
  } catch (e: any) {
    console.warn(`[GMAIL WEBHOOK] OIDC verification failed: ${e.message}`);
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const envelope = PubSubEnvelopeSchema.safeParse(await req.json());
    if (!envelope.success) {
      return NextResponse.json({ error: envelope.error.issues }, { status: 400 });
    }

    // PB-6: dedup at the envelope.messageId level BEFORE any side-effect work.
    // Pub/Sub redelivery (at-least-once) is the common case; without this
    // guard we re-walk gmail.history.list on every retry and amplify PB-5's
    // missed-notification bug. INSERT OR IGNORE pattern via P2002 catch.
    const envelopeMessageId = envelope.data.message.messageId;
    try {
      await prisma.webhookDelivery.create({
        data: { messageId: envelopeMessageId, source: "gmail" },
      });
    } catch (err: any) {
      if (err?.code === "P2002") {
        // Redelivery — already processed. Return 200 so Pub/Sub stops retrying.
        console.info(`[GMAIL WEBHOOK] dedup hit for messageId=${envelopeMessageId}`);
        return NextResponse.json({ success: true, deduped: true }, { status: 200 });
      }
      throw err;
    }

    const decodedStr = Buffer.from(envelope.data.message.data, 'base64').toString('utf-8');
    const payloadParsed = PubSubPayloadSchema.safeParse(JSON.parse(decodedStr));
    if (!payloadParsed.success) {
      return NextResponse.json({ error: payloadParsed.error.issues }, { status: 400 });
    }

    const { emailAddress, historyId } = payloadParsed.data;

    const user = await findUserByEmailWithAccounts(emailAddress);
    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const authClient = await getGoogleAuthClient(user.id);
    const gmail = google.gmail({ version: "v1", auth: authClient });

    // PB-5 audit finding: prefer the user's persisted checkpoint over the
    // envelope's historyId when it's older. The envelope tells us "history
    // went past this point"; resuming from our own checkpoint catches any
    // events we missed on a previous webhook that crashed mid-batch.
    const envelopeHistoryId = String(historyId);
    const startHistoryId = user.lastSyncedHistoryId
        && BigInt(user.lastSyncedHistoryId) < BigInt(envelopeHistoryId)
      ? user.lastSyncedHistoryId
      : envelopeHistoryId;

    // C4: if startHistoryId is older than Gmail's retained history window (the
    // webhook was down > ~7d), history.list 404s. Re-seed the watermark to the
    // envelope's historyId and ack 200 so Pub/Sub stops retrying — the manual
    // Scan Inbox backfill recovers the gap, and the next push resumes cleanly
    // from the re-seed. Any non-404 error is a real failure → rethrow → 500.
    const historyRes = await gmail.users.history
      .list({ userId: "me", startHistoryId })
      .catch((histErr: unknown) => {
        if (isStaleHistoryError(histErr)) return null;
        throw histErr;
      });
    if (historyRes === null) {
      console.warn(`[GMAIL WEBHOOK] history.list 404 (startHistoryId=${startHistoryId} too old) — re-seeding lastSyncedHistoryId=${envelopeHistoryId}, acking 200`);
      await prisma.user.update({
        where: { id: user.id },
        data: { lastSyncedHistoryId: envelopeHistoryId },
      });
      return NextResponse.json({ success: true, reseeded: true }, { status: 200 });
    }

    const messagesAdded = historyRes.data.history?.flatMap((h: any) => h.messagesAdded || []) || [];

    const counts = { created: 0, updated: 0, skipped: 0, errored: 0 };

    for (const msgAdded of messagesAdded) {
      const id = msgAdded.message?.id;
      if (!id) continue;

      // PB-5 audit finding: a single bad message must NOT abort the batch.
      // Catch per-msg and continue so messages 6-N still process when msg 5
      // throws. The original loop already used a return type (`outcome`) for
      // errored — we just need to also catch unexpected throws.
      //
      // OQ9b (P4.3.2): every errored outcome ALSO lands a FailedIngest row so
      // the scheduler retry queue (scheduler/jobs/failed-ingest-retry.ts)
      // re-attempts it with backoff. attempts stays 0 here — a Pub/Sub
      // re-walk re-failing the same msg only refreshes lastError; the queue
      // owns the schedule. The watermark advance below is UNCHANGED: recovery
      // is by msgId, not by holding lastSyncedHistoryId. Both helpers are
      // best-effort internally (never throw), so they can't abort the batch.
      try {
        const outcome = await ingestGmailMessage({ userId: user.id, gmail, msgId: id });
        counts[outcome.action] = (counts[outcome.action] ?? 0) + 1;
        if (outcome.action === "errored") {
          console.warn(`[GMAIL WEBHOOK] ingest failed for msg ${id}: ${outcome.reason}`);
          await recordFailedIngest({ msgId: id, userId: user.id, error: outcome.reason });
        } else {
          // Non-errored (created/updated/skipped) on a re-walk supersedes any
          // queued retry for this msg — drop it so the queue never re-pays a
          // parse for a message that already made it through.
          await clearFailedIngest(id);
        }
      } catch (perMsgErr: any) {
        counts.errored++;
        console.warn(`[GMAIL WEBHOOK] ingest threw for msg ${id}:`, perMsgErr?.message ?? perMsgErr);
        await recordFailedIngest({
          msgId: id,
          userId: user.id,
          error: `ingest threw: ${perMsgErr?.message ?? String(perMsgErr)}`,
        });
      }
    }

    // Advance the per-user checkpoint to the envelope's historyId. Gmail
    // history.list returns a `historyId` on the response that we could use
    // instead, but the envelope's value is monotonic and unambiguously >=
    // every msg we just processed.
    await prisma.user.update({
      where: { id: user.id },
      data: { lastSyncedHistoryId: envelopeHistoryId },
    });

    console.info(`[GMAIL WEBHOOK] history=${historyId} ${JSON.stringify(counts)}`);
    return NextResponse.json({ success: true, ...counts }, { status: 200 });
  } catch (error: any) {
    console.error("Error in Gmail webhook:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
