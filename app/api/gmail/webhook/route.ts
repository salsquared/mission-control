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
} from "@/lib/repositories/applications";
import { verifyPubSubOIDC } from "@/lib/google-oidc";

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

    // Lookup user by email in NextAuth account
    const user = await findUserByEmailWithAccounts(emailAddress);

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const authClient = await getGoogleAuthClient(user.id);
    const gmail = google.gmail({ version: "v1", auth: authClient });

    // Fetch the new messages based on the history log
    const historyRes = await gmail.users.history.list({
      userId: "me",
      startHistoryId: String(historyId),
    });

    const messagesAdded = historyRes.data.history?.flatMap((h: any) => h.messagesAdded || []) || [];
    
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
      const subjectHeader = headers.find(h => h.name === 'Subject');
      const subject = subjectHeader ? subjectHeader.value || "" : "";
      
      // Attempt to get text body
      let bodyText = "";
      if (payload?.parts) {
        // Multi-part message
        const textPart = payload.parts.find(p => p.mimeType === "text/plain");
        if (textPart && textPart.body?.data) {
          bodyText = Buffer.from(textPart.body.data, "base64").toString("utf-8");
        }
      } else if (payload?.body?.data) {
        // Single part
        bodyText = Buffer.from(payload.body.data, "base64").toString("utf-8");
      }

      // If it looks like an application email, trigger Gemini parsing
      if (subject.toLowerCase().includes("application") || subject.toLowerCase().includes("interview")) {
         const parsed = await parseApplicationEmail(bodyText, subject);

         // Upsert application based on Company matching (heuristic)
         const existingApp = await findApplicationByCompany(user.id, parsed.company);

         let appId: string;
         if (existingApp) {
           await updateApplication(existingApp.id, {
             status: parsed.status,
             nextSteps: parsed.nextSteps,
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
             dateApplied: new Date(),
             lastUpdateAt: new Date(),
           });
           appId = newApp.id;
         }
         broadcastEvent({ model: 'Application', action: 'upsert', id: appId, timestamp: Date.now() });
      }
    }

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error: any) {
    console.error("Error in Gmail webhook:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
