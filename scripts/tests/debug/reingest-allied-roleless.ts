/**
 * One-off cleanup (2026-05-28): the roleless Allied Universal "finish your
 * form" email (msg 19e6bae01e52855a) created a phantom career-track app
 * (cmpoogopy000lt0dxl5w60a1i, role "Unknown") before the roleless-merge fix
 * landed in lib/applications/ingest.ts. This deletes that phantom row and
 * re-ingests the message so the new path merges it into the most-recent
 * Allied side app instead.
 *
 * Safety ordering: fetch the Gmail message FIRST (read-only) to confirm it's
 * still re-fetchable; only then delete the phantom (which cascades its events)
 * and re-ingest. So we never destroy the EMAIL_RECEIVED record without first
 * proving we can recreate it.
 *
 *   DATABASE_URL="file:./dev.db" npx tsx scripts/tests/debug/reingest-allied-roleless.ts
 */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { google } from "googleapis";
import { getGoogleAuthClient } from "@/lib/googleapis";
import { ingestGmailMessage } from "@/lib/applications/ingest";

const PHANTOM_APP_ID = "cmpoogopy000lt0dxl5w60a1i";
const MSG_ID = "19e6bae01e52855a";

const prisma = new PrismaClient();

async function main() {
    const phantom = await prisma.application.findUnique({
        where: { id: PHANTOM_APP_ID },
        select: { id: true, userId: true, company: true, role: true, track: true, lastEmailMsgId: true },
    });
    if (!phantom) {
        console.error(`[ERR] phantom app ${PHANTOM_APP_ID} not found — already cleaned up?`);
        process.exit(1);
    }
    console.log(`Phantom: ${phantom.company} / ${JSON.stringify(phantom.role)} (track=${phantom.track}) owner=${phantom.userId}`);
    const userId = phantom.userId;
    const msgId = phantom.lastEmailMsgId ?? MSG_ID;

    // 1. Read-only confirm the message is still fetchable before we delete.
    const authClient = await getGoogleAuthClient(userId);
    const gmail = google.gmail({ version: "v1", auth: authClient });
    try {
        const probe = await gmail.users.messages.get({ userId: "me", id: msgId, format: "metadata" });
        const subj = (probe.data.payload?.headers ?? []).find(h => (h.name ?? "").toLowerCase() === "subject")?.value;
        console.log(`Gmail message ${msgId} is fetchable. Subject: ${JSON.stringify(subj)}`);
    } catch (e: any) {
        console.error(`[ERR] Gmail message ${msgId} not fetchable — aborting WITHOUT deleting. ${e?.message ?? e}`);
        process.exit(1);
    }

    // 2. Delete the phantom (ApplicationEvent cascades via onDelete: Cascade).
    const evCount = await prisma.applicationEvent.count({ where: { applicationId: PHANTOM_APP_ID } });
    await prisma.application.delete({ where: { id: PHANTOM_APP_ID } });
    console.log(`Deleted phantom app (cascaded ${evCount} event(s)).`);

    // 3. Re-ingest. With the phantom gone, the fast-path's priorEvents check is
    //    empty, so the full pipeline runs and the roleless-merge branch fires.
    const outcome = await ingestGmailMessage({ userId, gmail, msgId, broadcast: false });
    console.log(`Re-ingest outcome: ${JSON.stringify(outcome)}`);

    // 4. Verify final state.
    if (outcome.action === "updated" || outcome.action === "created") {
        const target = await prisma.application.findUnique({
            where: { id: outcome.appId },
            select: { id: true, company: true, role: true, track: true },
        });
        console.log(`Merged into: ${JSON.stringify(target)}`);
    }
    const remainingAlliedCareer = await prisma.application.count({
        where: { userId, normalizedCompany: "Allied Universal", track: "career" },
    });
    const emailNowOn = await prisma.applicationEvent.findFirst({
        where: { emailMsgId: msgId, application: { userId } },
        select: { kind: true, applicationId: true },
    });
    console.log(`Allied career-track apps remaining: ${remainingAlliedCareer} (expect 0)`);
    console.log(`Email ${msgId} EMAIL_RECEIVED now attached to app: ${emailNowOn?.applicationId ?? "(none)"}`);
}

main()
    .catch((e) => { console.error("Unhandled:", e); process.exit(2); })
    .finally(() => prisma.$disconnect());
