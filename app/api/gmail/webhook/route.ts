import { NextRequest, NextResponse } from "next/server";
import { getGoogleAuthClient } from "@/lib/googleapis";
import { google } from "googleapis";
import { prisma } from "@/lib/prisma";
import { parseApplicationEmail } from "@/lib/email-parser";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    
    // Google Cloud Pub/Sub push notification format
    if (!body.message || !body.message.data) {
      return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
    }

    // Decode message string from base64
    const decodedStr = Buffer.from(body.message.data, 'base64').toString('utf-8');
    const data = JSON.parse(decodedStr);
    const emailAddress = data.emailAddress;
    const historyId = data.historyId;

    if (!emailAddress) {
      return NextResponse.json({ error: "No email address found" }, { status: 400 });
    }

    // Lookup user by email in NextAuth account
    const user = await prisma.user.findUnique({
      where: { email: emailAddress },
      include: { accounts: true }
    });

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const authClient = await getGoogleAuthClient(user.id);
    const gmail = google.gmail({ version: "v1", auth: authClient });

    // Fetch the new messages based on the history log
    const historyRes = await gmail.users.history.list({
      userId: "me",
      startHistoryId: historyId,
    });

    const messagesAdded = historyRes.data.history?.flatMap(h => h.messagesAdded || []) || [];
    
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
         const existingApp = await prisma.application.findFirst({
           where: { userId: user.id, company: { contains: parsed.company } }
         });

         if (existingApp) {
           await prisma.application.update({
             where: { id: existingApp.id },
             data: {
               status: parsed.status,
               nextSteps: parsed.nextSteps,
               role: parsed.role || existingApp.role, // only override if LLM specifies
               lastUpdateAt: new Date()
             }
           });
         } else {
           await prisma.application.create({
             data: {
               userId: user.id,
               company: parsed.company,
               role: parsed.role || "Unknown",
               status: parsed.status,
               nextSteps: parsed.nextSteps,
               dateApplied: new Date(),
               lastUpdateAt: new Date()
             }
           });
         }
      }
    }

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error: any) {
    console.error("Error in Gmail webhook:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
