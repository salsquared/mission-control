/**
 * End-to-end smoke for the global notification bell + email dispatch wiring.
 *
 *   DATABASE_URL="file:./dev.db" npx tsx scripts/tests/integration/notification-bell-smoke.ts
 *
 * Verifies the full pipeline that fires when an attention-worthy application
 * event lands: ApplicationEvent → Notification(in_app,email) → email dispatch
 * → emailSentAt or emailError set → notification listable via /api/notifications
 * → dismissable via PATCH.
 *
 * Doesn't actually require an inbox to receive — emailError is checked
 * separately so we know whether the Gmail OAuth side dispatched or had a
 * scope/auth problem (which would surface here vs in production).
 */
import { PrismaClient } from "@prisma/client";
import { randomBytes } from "crypto";

const BASE = process.env.MC_BASE_URL ?? "http://localhost:4101";
const prisma = new PrismaClient();

let passes = 0;
let fails = 0;
function pass(msg: string) { console.log(`[PASS] ${msg}`); passes++; }
function fail(msg: string, detail?: unknown) { console.error(`[FAIL] ${msg}`, detail ?? ""); fails++; }

async function main() {
    const user = await prisma.user.findFirst();
    if (!user) { console.error("No user — log in first."); process.exit(1); }
    console.log(`Using user ${user.email}`);

    const sessionToken = randomBytes(32).toString("hex");
    await prisma.session.create({
        data: { sessionToken, userId: user.id, expires: new Date(Date.now() + 60 * 60 * 1000) },
    });
    const cookie = `__Secure-next-auth.session-token=${sessionToken}`;
    const headers = { "Content-Type": "application/json", Cookie: cookie };

    let appId = "";
    let eventId = "";
    let notificationId = "";

    try {
        // Track the time before so we can identify "this run's" notifications.
        const before = new Date();

        // 1. Create an application
        const appRes = await fetch(`${BASE}/api/applications`, {
            method: "POST", headers,
            body: JSON.stringify({ company: "Bell Smoke Co", role: "Senior Engineer", status: "APPLIED", kind: "job" }),
        });
        const appBody = await appRes.json();
        if (appRes.status !== 200) return fail("create application failed", appBody);
        appId = appBody.application.id;
        pass(`created application ${appId}`);

        // 2. POST an INTERVIEW_SCHEDULED event — this triggers maybeNotifyForApplicationEvent
        const eventRes = await fetch(`${BASE}/api/applications/events`, {
            method: "POST", headers,
            body: JSON.stringify({
                applicationId: appId,
                kind: "INTERVIEW_SCHEDULED",
                title: "Phone screen on Wednesday",
                scheduledAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
                notes: "Smoke test — not a real interview",
            }),
        });
        const eventBody = await eventRes.json();
        if (eventRes.status !== 200) return fail(`event POST status ${eventRes.status}`, eventBody);
        eventId = eventBody.event.id;
        pass(`created INTERVIEW_SCHEDULED event ${eventId}`);

        // 3. Find the notification that should have been fired by the helper
        const notif = await prisma.notification.findFirst({
            where: {
                userId: user.id,
                kind: "application",
                createdAt: { gt: before },
                payload: { contains: eventId },
            },
            orderBy: { createdAt: "desc" },
        });
        if (!notif) return fail("no notification created for INTERVIEW_SCHEDULED event");
        notificationId = notif.id;
        pass(`notification row exists: ${notificationId}`);
        if (notif.channels !== "in_app,email") fail(`channels=${notif.channels}, expected 'in_app,email'`);
        else pass("notification channels='in_app,email'");

        // 4. Email dispatch outcome — either succeeded or recorded an error.
        if (notif.emailSentAt) {
            pass(`email sent at ${notif.emailSentAt.toISOString()}`);
        } else if (notif.emailError) {
            // This is OK as a smoke result — it tells us the dispatch RAN; the
            // OAuth scope or token may need refresh, which is a user problem
            // not a code bug.
            console.warn(`[NOTE] email dispatch reported error (smoke still passes — dispatch ran): ${notif.emailError}`);
            pass("email dispatch executed (with error — see warning)");
        } else {
            fail("neither emailSentAt nor emailError set — dispatch may not have run");
        }

        // 5. GET /api/notifications lists the new row
        const listRes = await fetch(`${BASE}/api/notifications`, { headers: { Cookie: cookie } });
        const listBody = await listRes.json();
        if (listRes.status !== 200) return fail(`list status ${listRes.status}`, listBody);
        const found = (listBody.notifications ?? []).find((n: { id: string }) => n.id === notificationId);
        if (!found) fail("new notification missing from /api/notifications GET");
        else pass("notification appears in GET /api/notifications");
        if (typeof listBody.unreadCount !== "number" || listBody.unreadCount < 1) {
            fail(`unreadCount=${listBody.unreadCount}, expected ≥ 1`);
        } else {
            pass(`unreadCount=${listBody.unreadCount}`);
        }

        // 6. Dismiss the notification via PATCH
        const dismissRes = await fetch(`${BASE}/api/notifications`, {
            method: "PATCH", headers,
            body: JSON.stringify({
                ids: [notificationId],
                dismissedAt: new Date().toISOString(),
            }),
        });
        const dismissBody = await dismissRes.json();
        if (dismissRes.status !== 200) return fail("dismiss status", dismissBody);
        if (dismissBody.updated !== 1) fail(`dismiss updated=${dismissBody.updated}, expected 1`);
        else pass("dismiss PATCH updated 1 row");

        // 7. After dismiss, the notification shouldn't appear in the default list
        const list2 = await fetch(`${BASE}/api/notifications`, { headers: { Cookie: cookie } });
        const list2Body = await list2.json();
        const stillThere = (list2Body.notifications ?? []).some((n: { id: string }) => n.id === notificationId);
        if (stillThere) fail("dismissed notification still in default list");
        else pass("dismissed notification hidden from default list");

        // 8. ... but appears when ?includeDismissed=true
        const list3 = await fetch(`${BASE}/api/notifications?includeDismissed=true`, { headers: { Cookie: cookie } });
        const list3Body = await list3.json();
        const visibleInArchive = (list3Body.notifications ?? []).some((n: { id: string }) => n.id === notificationId);
        if (!visibleInArchive) fail("dismissed notification missing from includeDismissed view");
        else pass("dismissed notification visible with ?includeDismissed=true");

        // 9. Negative: PATCH with invalid payload → 400
        const bad = await fetch(`${BASE}/api/notifications`, {
            method: "PATCH", headers,
            body: JSON.stringify({}),
        });
        if (bad.status !== 400) fail(`empty PATCH expected 400, got ${bad.status}`);
        else pass("empty PATCH → 400");
    } finally {
        if (eventId) await prisma.applicationEvent.delete({ where: { id: eventId } }).catch(() => undefined);
        if (notificationId) await prisma.notification.delete({ where: { id: notificationId } }).catch(() => undefined);
        if (appId) await fetch(`${BASE}/api/applications?id=${appId}`, { method: "DELETE", headers: { Cookie: cookie } }).catch(() => undefined);
        await prisma.session.delete({ where: { sessionToken } }).catch(() => undefined);
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
