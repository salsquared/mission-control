import { NextRequest, NextResponse } from "next/server";
import { getGoogleAuthClient } from "@/lib/googleapis";
import { google } from "googleapis";
import { parseApplicationEmail } from "@/lib/email-parser";
import { broadcastEvent } from "@/lib/events";
import { PubSubEnvelopeSchema, PubSubPayloadSchema } from "@/lib/schemas/gmail-webhook";
import { findUserByEmailWithAccounts } from "@/lib/repositories/users";
import {
  findApplicationByCompany,
  createApplication,
  updateApplication,
  createApplicationEmailIfNew,
} from "@/lib/repositories/applications";
import { updateWatchHistoryId } from "@/lib/repositories/gmail-watches";
import { verifyPubSubOIDC } from "@/lib/google-oidc";

// Pin to Node runtime — this route uses googleapis + jose, both of which pull
// in `node:*` imports (notably undici → node:assert) that the edge runtime
// can't handle. serverExternalPackages in next.config also keeps them out of
// the webpack bundle; this export is belt-and-suspenders.
export const runtime = 'nodejs';

// Recruiter / ATS phrases that warrant LLM parsing. Kept as a single regex so
// adding a phrase is cheap. False positives are fine — the LLM gets to discard
// them — but every match costs an API call.
const APPLICATION_SUBJECT_RE = /\b(application|applying|interview|offer|candidacy|next steps?|assessment|coding challenge|take[- ]home|onsite|recruit(er|ing)?|regret|unfortunately)\b/i;

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
    let touchedApp = false;

    for (const msgAdded of messagesAdded) {
      if (!msgAdded.message || !msgAdded.message.id) continue;

      const msgRes = await gmail.users.messages.get({
        userId: "me",
        id: msgAdded.message.id,
        format: "full"
      });

      const message = msgRes.data;
      const payload = message.payload;
      const headers = payload?.headers || [];
      const subject = headers.find(h => h.name === 'Subject')?.value || "";
      const fromAddress = headers.find(h => h.name === 'From')?.value || "";

      let bodyText = "";
      if (payload?.parts) {
        const textPart = payload.parts.find(p => p.mimeType === "text/plain");
        if (textPart && textPart.body?.data) {
          bodyText = Buffer.from(textPart.body.data, "base64").toString("utf-8");
        }
      } else if (payload?.body?.data) {
        bodyText = Buffer.from(payload.body.data, "base64").toString("utf-8");
      }

      if (!APPLICATION_SUBJECT_RE.test(subject)) continue;

      const parsed = await parseApplicationEmail(bodyText, subject);
      const nextStepAt = pickFutureDate(parsed.extractedDates);

      const existingApp = await findApplicationByCompany(user.id, parsed.company);

      let appId: string;
      if (existingApp) {
        await updateApplication(existingApp.id, {
          status: parsed.status,
          nextSteps: parsed.nextSteps,
          nextStepAt,
          role: parsed.role || existingApp.role,
          lastUpdateAt: new Date(),
        });
        appId = existingApp.id;
      } else {
        const newApp = await createApplication({
          userId: user.id,
          company: parsed.company,
          role: parsed.role || "Unknown",
          status: parsed.status,
          nextSteps: parsed.nextSteps,
          nextStepAt,
          dateApplied: new Date(),
          lastUpdateAt: new Date(),
        });
        appId = newApp.id;
      }

      const receivedAt = message.internalDate
        ? new Date(Number(message.internalDate))
        : new Date();
      await createApplicationEmailIfNew({
        applicationId: appId,
        messageId: msgAdded.message.id,
        threadId: message.threadId ?? null,
        subject,
        fromAddress,
        receivedAt,
        snippet: message.snippet ?? null,
        parsedStatus: parsed.status,
      });

      touchedApp = true;
      broadcastEvent({ model: 'Application', action: 'upsert', id: appId, timestamp: Date.now() });
    }

    // Advance the stored historyId so subsequent deliveries start from here.
    // Best-effort — no row exists if watch was never installed via our route.
    try {
      await updateWatchHistoryId(user.id, String(historyId));
    } catch {
      // No GmailWatch row yet; ignore.
    }

    return NextResponse.json({ success: true, touched: touchedApp }, { status: 200 });
  } catch (error: any) {
    console.error("Error in Gmail webhook:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

function pickFutureDate(extractedDates: string[] | undefined): Date | null {
  if (!extractedDates || extractedDates.length === 0) return null;
  const now = Date.now();
  const candidates = extractedDates
    .map(s => new Date(s))
    .filter(d => !isNaN(d.getTime()) && d.getTime() > now)
    .sort((a, b) => a.getTime() - b.getTime());
  return candidates[0] ?? null;
}
