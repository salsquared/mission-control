import { NextRequest, NextResponse } from "next/server";
import { getGoogleAuthClient } from "@/lib/googleapis";
import { google } from "googleapis";
import { PubSubEnvelopeSchema, PubSubPayloadSchema } from "@/lib/schemas/gmail-webhook";
import { findUserByEmailWithAccounts } from "@/lib/repositories/users";
import { ingestGmailMessage } from "@/lib/applications/ingest";
import { verifyPubSubOIDC } from "@/lib/google-oidc";

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
  try {
    await verifyPubSubOIDC(req, audience);
  } catch (e: any) {
    console.warn(`[GMAIL WEBHOOK] OIDC verification failed: ${e.message}`);
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const envelope = PubSubEnvelopeSchema.safeParse(await req.json());
    if (!envelope.success) {
      return NextResponse.json({ error: envelope.error.issues }, { status: 400 });
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

    const historyRes = await gmail.users.history.list({
      userId: "me",
      startHistoryId: String(historyId),
    });

    const messagesAdded = historyRes.data.history?.flatMap((h: any) => h.messagesAdded || []) || [];

    const counts = { created: 0, updated: 0, skipped: 0, errored: 0 };

    for (const msgAdded of messagesAdded) {
      const id = msgAdded.message?.id;
      if (!id) continue;

      const outcome = await ingestGmailMessage({ userId: user.id, gmail, msgId: id });
      counts[outcome.action] = (counts[outcome.action] ?? 0) + 1;
      if (outcome.action === "errored") {
        console.warn(`[GMAIL WEBHOOK] ingest failed for msg ${id}: ${outcome.reason}`);
      }
    }

    console.info(`[GMAIL WEBHOOK] history=${historyId} ${JSON.stringify(counts)}`);
    return NextResponse.json({ success: true, ...counts }, { status: 200 });
  } catch (error: any) {
    console.error("Error in Gmail webhook:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
