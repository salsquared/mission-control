import { PrismaClient } from "@prisma/client";
import { getGoogleAuthClient } from "../../lib/googleapis";
import { google } from "googleapis";

const basePrisma = global as unknown as { prisma: PrismaClient };
const prisma = basePrisma.prisma || new PrismaClient();

const testUserEmail = process.argv[2];

if (!testUserEmail) {
  console.error("Please provide the test user email as an argument:");
  console.error("npx tsx scripts/tests/test-automated-email.ts user@gmail.com");
  process.exit(1);
}

// These templates precisely test the AI extraction pipeline's ability to mutate the DB Kanban board
const emailTemplates = [
  { 
    subject: "Application Received: Software Engineer at Acme Corp", 
    body: "Thank you for applying to Acme Corp. We have received your application for the Software Engineer role." 
  },
  { 
    subject: "Update on your application to Acme Corp", 
    body: "We need some more information before moving forward. Please fill out the attached background check form by Friday." 
  },
  { 
    subject: "Action Required: Take-home assessment for Acme Corp", 
    body: "You have moved to the assessment phase. Click here to start your 2-hour coding test via HackerRank." 
  },
  { 
    subject: "Interview Request: Acme Corp", 
    body: "We'd like to invite you to a preliminary phone screen next Tuesday at 2 PM PST. Let us know if this works." 
  },
  { 
    subject: "Interview Scheduled: Acme Corp", 
    body: "Your interview is confirmed for Tuesday at 2 PM PST. Here is the Zoom link: https://zoom.us/j/123456" 
  },
  { 
    subject: "Offer from Acme Corp!", 
    body: "We are thrilled to extend an offer for the Software Engineer position! Please review the attached compensation package." 
  }
];

async function run() {
  const user = await prisma.user.findUnique({ where: { email: testUserEmail } });
  if (!user) {
    throw new Error(`User ${testUserEmail} not found in Database. Please authenticate via the Mission Control Dashboard first.`);
  }

  const authClient = await getGoogleAuthClient(user.id);
  const gmail = google.gmail({ version: "v1", auth: authClient });

  for (const template of emailTemplates) {
    console.log(`[TEST SUITE] Dispatching Email: ${template.subject}`);
    
    const utf8Subject = `=?utf-8?B?${Buffer.from(template.subject).toString('base64')}?=`;
    const messageParts = [
      `From: Test Company <careers@acmecorp.example.com>`,
      `To: ${testUserEmail}`,
      `Subject: ${utf8Subject}`,
      `MIME-Version: 1.0`,
      `Content-Type: text/plain; charset="UTF-8"`,
      ``,
      template.body,
    ];
    
    // Convert to web-safe base64
    const message = messageParts.join('\n');
    const encodedMessage = Buffer.from(message)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    await gmail.users.messages.send({
      userId: "me", // Send on behalf of the user to themselves, dropping it into the inbox
      requestBody: { raw: encodedMessage }
    });
    
    console.log("  -> Sent successfully. Waiting 10 seconds to allow the Webhook to parse and update the DB...");
    await new Promise(resolve => setTimeout(resolve, 10000));
  }
  
  console.log("✅ All test email templates successfully dispatched! Check the Applications Dashboard View to verify.");
}

run()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
