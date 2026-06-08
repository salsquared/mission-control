/**
 * Hermetic smoke for purgeApplicationEvents (lib/calendar/sync.ts). Fix C of
 * docs/postmortem-self-notification-mail-loop.html §11.
 *
 * Verifies the gcal-sweep-before-delete contract:
 *   - events WITH a gcalEventId trigger a deleteEventFromGcal sweep (counted),
 *   - events WITHOUT a gcalEventId are tolerated (no throw, still deleted),
 *   - all rows are removed after the call.
 *
 * The throwaway user has no Google OAuth grant, so the gcal leg fails auth and
 * is swallowed by deleteEventFromGcal's catch — which is exactly the
 * best-effort behavior we want to prove: a calendar hiccup never blocks the row
 * deletion. (Expect a benign "[gcal-sync] auth failed" warn in the output.)
 *
 *   DATABASE_URL="file:./dev.db" npx tsx scripts/tests/hermetic/purge-application-events-smoke.ts
 */
import { PrismaClient } from "@prisma/client";
import { createApplication } from "@/lib/repositories/applications";
import { purgeApplicationEvents } from "@/lib/calendar/sync";

const prisma = new PrismaClient();
const TEST_EMAIL = "purge-events-smoke@mission-control.test";

let passes = 0;
let fails = 0;
function check(name: string, cond: boolean, detail?: unknown) {
    if (cond) { console.log(`[PASS] ${name}`); passes++; }
    else { console.error(`[FAIL] ${name}`, detail ?? ""); fails++; }
}

async function main() {
    await prisma.user.deleteMany({ where: { email: TEST_EMAIL } }).catch(() => undefined);
    const user = await prisma.user.create({ data: { email: TEST_EMAIL, name: "Purge Smoke" } });

    try {
        const app = await createApplication({
            userId: user.id,
            company: "Purge Smoke Co",
            role: "Engineer",
            status: "APPLIED",
            track: "career",
        });

        // Event WITH a gcalEventId (will be swept) …
        const withGcal = await prisma.applicationEvent.create({
            data: {
                applicationId: app.id,
                kind: "INTERVIEW_SCHEDULED",
                title: "Interview",
                occurredAt: new Date(),
                scheduledAt: new Date(Date.now() + 86_400_000),
                gcalEventId: "fake-gcal-id-xyz",
                emailMsgId: "purge-smoke-1",
                syncSource: "ms",
            },
        });
        // … and one WITHOUT (null gcalEventId — must be tolerated).
        const noGcal = await prisma.applicationEvent.create({
            data: {
                applicationId: app.id,
                kind: "ASSESSMENT_REQUESTED",
                title: "Assessment",
                occurredAt: new Date(),
                gcalEventId: null,
                emailMsgId: "purge-smoke-2",
                syncSource: "ms",
            },
        });

        const result = await purgeApplicationEvents([withGcal.id, noGcal.id]);

        check("gcalSwept === 1 (only the event with a gcalEventId was swept)", result.gcalSwept === 1, result);
        check("deletedRows === 2 (both rows deleted)", result.deletedRows === 2, result);

        const remaining = await prisma.applicationEvent.findMany({
            where: { id: { in: [withGcal.id, noGcal.id] } },
        });
        check("both event rows are gone from the DB", remaining.length === 0, remaining.map(r => r.id));

        // Empty input is a no-op (guards against a deleteMany with an empty `in`).
        const empty = await purgeApplicationEvents([]);
        check("empty input → no-op { 0, 0 }", empty.deletedRows === 0 && empty.gcalSwept === 0, empty);
    } finally {
        await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
        await prisma.$disconnect();
        console.log(`\n${passes}/${passes + fails} steps passed`);
        if (fails === 0) console.log("All checks passed.");
    }
    if (fails > 0) process.exit(1);
}

main().catch(e => {
    console.error("Unhandled error:", e);
    process.exit(2);
});
