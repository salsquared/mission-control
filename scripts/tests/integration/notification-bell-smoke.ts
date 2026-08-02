/**
 * End-to-end smoke for the global notification bell + the PB-11 manual-entry
 * no-notify invariant.
 *
 *   DATABASE_URL="file:./dev.db" npx tsx scripts/tests/integration/notification-bell-smoke.ts
 *
 * PREMISE REPAIR (2026-08-01). This suite used to POST an INTERVIEW_SCHEDULED
 * event to /api/applications/events and expect a Notification to appear. The
 * app removed that behaviour deliberately (PB-11, was RAH-16): the manual-entry
 * route does NOT call maybeNotifyForApplicationEvent, because a user who just
 * clicked "I got an offer" does not need a critical-tier self-email telling them
 * so — see the comment at app/api/applications/events/route.ts:94. Only the
 * ingest path (Gmail webhook → lib/applications/ingest.ts) notifies. The old
 * assertion pinned the REMOVED contract, so it failed on every run.
 *
 * The suite now pins BOTH halves of the CURRENT contract:
 *
 *   - NEGATIVE (steps 3 + 10) — the manual-entry POST creates no Notification
 *     for its event. Nothing else guarded this. A regression that re-added the
 *     notify call to that route is a self-notification email loop, which is the
 *     failure this repo already has a postmortem for
 *     (docs/archive/postmortem-self-notification-mail-loop.html). Checked twice:
 *     immediately after the POST, and again at the end of the run, so a
 *     fire-and-forget (un-awaited) re-add that lands late is still caught.
 *
 *   - POSITIVE (steps 4-5) — maybeNotifyForApplicationEvent still produces a
 *     critical-tier in_app,email row, driven the way ingest drives it (same
 *     function, same throwOnError:true). Deliberately NOT by forging a Gmail
 *     push envelope: a fabricated webhook would test the fixture, not the app.
 *
 * Bell coverage (list / unread count / dismiss / archive / 400) is unchanged —
 * it always passed; it just needed a notification to exist, and step 4 now
 * produces one through a real code path instead of a removed one.
 */
import { PrismaClient } from "@prisma/client";
import { randomBytes } from "crypto";
import { maybeNotifyForApplicationEvent } from "@/lib/repositories/applicationEvents";

/**
 * A smoke must never put mail in the owner's inbox. Until this rewrite that was
 * true BY ACCIDENT: the dispatch happened inside the dev server, which loads
 * EMAIL_ENABLED=0 from .env.development. Step 4 now dispatches IN THIS PROCESS,
 * and a tsx script loads no .env at all — so an EMAIL_ENABLED=1 exported in the
 * shell would send a real critical-tier email. Pin it here. lib/email/send.ts
 * reads the var per call (emailEnabled()), so assigning after the imports is
 * enough; step 5 asserts the mute actually took.
 */
process.env.EMAIL_ENABLED = "0";

const BASE = process.env.MC_BASE_URL ?? "http://localhost:4101";
const prisma = new PrismaClient();

const COMPANY = "Bell Smoke Co";
const MANUAL_EVENT_TITLE = "Manual entry — must NOT notify";
const NOTIFY_EVENT_TITLE = "Phone screen on Wednesday";
const NOTIFY_EVENT_NOTES = "Smoke test — not a real interview";

let passes = 0;
let fails = 0;
function pass(msg: string) { console.log(`[PASS] ${msg}`); passes++; }
function fail(msg: string, detail?: unknown) { console.error(`[FAIL] ${msg}`, detail ?? ""); fails++; }

interface EventResponse { event: { id: string } }

/**
 * Every notification that references this event, by either of the two links a
 * notify path leaves behind: the PB-8 dedupKey (`event:<id>`) and the eventId
 * inside the JSON payload. Checking both means a regression that changed the
 * dedupKey format still trips the negative assertion.
 */
function notificationsForEvent(userId: string, eventId: string) {
    return prisma.notification.findMany({
        where: {
            userId,
            OR: [
                { dedupKey: `event:${eventId}` },
                { payload: { contains: eventId } },
            ],
        },
    });
}

async function main() {
    // Pinned to the OWNER deliberately. The dev break-glass resolves every
    // request to the owner, so a fixture created as anyone else disagrees with
    // the identity the handlers will see. An unpinned findFirst() returns an
    // arbitrary row, and dev.db has held crew rows since 2026-08-01 — it still
    // happens to return the owner by insertion order, which is luck, not design.
    const user = await prisma.user.findFirst({ where: { role: "owner" } });
    if (!user) { console.error("No user — log in first."); process.exit(1); }
    console.log(`Using user ${user.email}`);

    const sessionToken = randomBytes(32).toString("hex");
    await prisma.session.create({
        data: { sessionToken, userId: user.id, expires: new Date(Date.now() + 60 * 60 * 1000) },
    });
    const cookie = `__Secure-next-auth.session-token=${sessionToken}`;
    const headers = { "Content-Type": "application/json", Cookie: cookie };

    let appId = "";
    let manualEventId = "";
    let notifyEventId = "";
    let notificationId = "";

    try {
        // 1. Create an application
        const appRes = await fetch(`${BASE}/api/applications`, {
            method: "POST", headers,
            // `track` is REQUIRED by ApplicationCreate (lib/schemas/applications.ts)
            // since d424225 (2026-05-27); omitting it 400s with
            // `expected one of "career"|"side"`.
            body: JSON.stringify({ company: COMPANY, role: "Senior Engineer", status: "APPLIED", kind: "job", track: "career" }),
        });
        const appBody = await appRes.json();
        if (appRes.status !== 200) return fail("create application failed", appBody);
        appId = (appBody as { application: { id: string } }).application.id;
        pass(`created application ${appId}`);

        // 2. Manual-entry path: POST an INTERVIEW_SCHEDULED event. Kind chosen
        //    deliberately — it IS in NOTIFY_EVENT_KINDS, so if the route ever
        //    reinstates the notify call this event is exactly the one that
        //    would fire. A NOTE-kind event would pass step 3 vacuously.
        const manualRes = await fetch(`${BASE}/api/applications/events`, {
            method: "POST", headers,
            body: JSON.stringify({
                applicationId: appId,
                kind: "INTERVIEW_SCHEDULED",
                title: MANUAL_EVENT_TITLE,
                scheduledAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
                notes: "Smoke test — not a real interview",
            }),
        });
        const manualBody = await manualRes.json();
        if (manualRes.status !== 200) return fail(`manual event POST status ${manualRes.status}`, manualBody);
        manualEventId = (manualBody as EventResponse).event.id;
        pass(`manual-entry INTERVIEW_SCHEDULED event created: ${manualEventId}`);

        // 3. PB-11 INVARIANT — the manual-entry route must not have notified.
        {
            const leaked = await notificationsForEvent(user.id, manualEventId);
            if (leaked.length > 0) {
                fail(
                    "PB-11 VIOLATED: POST /api/applications/events created a Notification. " +
                    "The manual-entry path must not notify (route.ts:94) — re-adding " +
                    "maybeNotifyForApplicationEvent there is the self-email loop from " +
                    "docs/archive/postmortem-self-notification-mail-loop.html",
                    leaked.map(n => ({ id: n.id, channels: n.channels, dedupKey: n.dedupKey })),
                );
            } else {
                pass("manual-entry event produced NO notification (PB-11)");
            }
        }

        // 4. POSITIVE PATH — the notify helper ingest actually calls. Same
        //    function, same options (throwOnError:true, per OQ8b) as
        //    lib/applications/ingest.ts:531. A second real event row backs it so
        //    the payload's eventId points at something that exists; the direct
        //    call is what makes this the INGEST contract rather than the route's.
        const scheduledAt = new Date(Date.now() + 8 * 86400_000);
        const notifyRes = await fetch(`${BASE}/api/applications/events`, {
            method: "POST", headers,
            body: JSON.stringify({
                applicationId: appId,
                kind: "INTERVIEW_SCHEDULED",
                title: NOTIFY_EVENT_TITLE,
                scheduledAt: scheduledAt.toISOString(),
                notes: NOTIFY_EVENT_NOTES,
            }),
        });
        const notifyEventBody = await notifyRes.json();
        if (notifyRes.status !== 200) return fail(`notify-fixture event POST status ${notifyRes.status}`, notifyEventBody);
        notifyEventId = (notifyEventBody as EventResponse).event.id;

        await maybeNotifyForApplicationEvent(
            {
                id: notifyEventId,
                kind: "INTERVIEW_SCHEDULED",
                title: NOTIFY_EVENT_TITLE,
                applicationId: appId,
                scheduledAt,
                notes: NOTIFY_EVENT_NOTES,
            },
            user.id,
            COMPANY,
            { throwOnError: true },
        );

        const notif = await prisma.notification.findFirst({ where: { dedupKey: `event:${notifyEventId}` } });
        if (!notif) return fail("maybeNotifyForApplicationEvent created no notification for an INTERVIEW_SCHEDULED event");
        notificationId = notif.id;
        pass(`notify path created notification ${notificationId}`);

        if (notif.userId !== user.id) fail(`notification userId=${notif.userId}, expected ${user.id}`);
        else pass("notification is scoped to the owner");
        if (notif.kind !== "application") fail(`kind=${notif.kind}, expected 'application'`);
        else pass("notification kind='application'");
        if (notif.tier !== "critical") fail(`tier=${notif.tier}, expected 'critical'`);
        else pass("notification tier='critical'");
        // The helper prefixes the company hint — a real, load-bearing contract
        // (it is what makes the bell row read "Acme — Phone screen", not just
        // "Phone screen").
        if (notif.title !== `${COMPANY} — ${NOTIFY_EVENT_TITLE}`) {
            fail(`title="${notif.title}", expected "${COMPANY} — ${NOTIFY_EVENT_TITLE}"`);
        } else {
            pass("notification title carries the company hint");
        }

        // Channels: critical tier defaults to in_app,email. The ONE sanctioned
        // deviation is the outbound-email circuit breaker stripping "email"
        // (lib/notifications/circuit-breaker.ts) — which it does only when this
        // user already engaged the email channel 10×/60s globally or 1×/10min
        // for this applicationId. A fresh application makes the per-feature
        // layer unreachable, so this normally holds exactly; the breaker branch
        // is accepted with a note rather than a red so a real 552-loop-in-
        // progress doesn't look like a code bug.
        if (notif.channels === "in_app,email") {
            pass("notification channels='in_app,email'");
        } else if (notif.channels === "in_app" && (notif.emailError ?? "").startsWith("circuit breaker")) {
            console.warn(`[NOTE] email channel stripped by the circuit breaker: ${notif.emailError}`);
            pass("notification channels stripped by the circuit breaker (documented deviation)");
        } else {
            fail(`channels=${notif.channels}, expected 'in_app,email'`, notif.emailError);
        }

        // 5. Email side-channel resolved. EMAIL_ENABLED is pinned to "0" at the
        //    top of this file, so the ONLY correct outcome is a recorded
        //    emailError. A non-null emailSentAt means the mute did not take and
        //    this smoke just emailed the owner — that is a failure, not a pass.
        if (notif.emailSentAt) {
            fail(`emailSentAt=${notif.emailSentAt.toISOString()} — EMAIL_ENABLED mute did not take; this run SENT REAL MAIL`);
        } else if (notif.emailError) {
            console.log(`[NOTE] email dispatch outcome: ${notif.emailError}`);
            pass("email dispatch ran and recorded its outcome (muted)");
        } else {
            fail("neither emailSentAt nor emailError set — the email side-channel never ran");
        }

        // 6. GET /api/notifications lists the new row
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

        // 7. Dismiss the notification via PATCH
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

        // 8. After dismiss, the notification shouldn't appear in the default list
        const list2 = await fetch(`${BASE}/api/notifications`, { headers: { Cookie: cookie } });
        const list2Body = await list2.json();
        const stillThere = (list2Body.notifications ?? []).some((n: { id: string }) => n.id === notificationId);
        if (stillThere) fail("dismissed notification still in default list");
        else pass("dismissed notification hidden from default list");

        // 9. ... but appears when ?includeDismissed=true
        const list3 = await fetch(`${BASE}/api/notifications?includeDismissed=true`, { headers: { Cookie: cookie } });
        const list3Body = await list3.json();
        const visibleInArchive = (list3Body.notifications ?? []).some((n: { id: string }) => n.id === notificationId);
        if (!visibleInArchive) fail("dismissed notification missing from includeDismissed view");
        else pass("dismissed notification visible with ?includeDismissed=true");

        // 10. Negative: PATCH with invalid payload → 400
        const bad = await fetch(`${BASE}/api/notifications`, {
            method: "PATCH", headers,
            body: JSON.stringify({}),
        });
        if (bad.status !== 400) fail(`empty PATCH expected 400, got ${bad.status}`);
        else pass("empty PATCH → 400");

        // 11. PB-11, re-checked at the END of the run. Step 3 fires microseconds
        //     after the POST returns; a regression that re-added the notify call
        //     WITHOUT awaiting it could land after that check. Everything above
        //     is several HTTP round-trips of real time, so re-asserting here
        //     closes that window.
        {
            const leakedLate = await notificationsForEvent(user.id, manualEventId);
            if (leakedLate.length > 0) {
                fail(
                    "PB-11 VIOLATED (late): a Notification for the manual-entry event appeared " +
                    "during the run — an un-awaited notify call in POST /api/applications/events",
                    leakedLate.map(n => ({ id: n.id, channels: n.channels })),
                );
            } else {
                pass("manual-entry event still has no notification at end of run (PB-11)");
            }
        }
    } finally {
        // Notifications first, matched by dedupKey/payload for BOTH events —
        // so a run that FAILS step 3 (i.e. the regression fired) still removes
        // the row it should never have created, instead of leaving it in the
        // owner's bell. Scoped to this run's two event ids, so it can never
        // touch a real notification.
        for (const eventId of [manualEventId, notifyEventId].filter(Boolean)) {
            const rows = await notificationsForEvent(user.id, eventId).catch(() => []);
            if (rows.length > 0) {
                await prisma.notification.deleteMany({ where: { id: { in: rows.map(r => r.id) } } }).catch(() => undefined);
            }
            // Through the ROUTE, not a raw row delete: DELETE /api/applications/
            // events runs purgeApplicationEvents, which sweeps the mirrored
            // Google Calendar entry first. Deleting the row directly (or letting
            // the Application delete cascade it — deleteApplication is a bare
            // prisma.delete) orphans a real calendar event on the owner's
            // calendar whenever GCAL_SYNC_ENABLED=1. Prisma is the fallback for
            // when the HTTP call itself fails.
            const r = await fetch(`${BASE}/api/applications/events?id=${eventId}`, {
                method: "DELETE", headers: { Cookie: cookie },
            }).catch(() => null);
            if (!r || r.status !== 200) {
                await prisma.applicationEvent.delete({ where: { id: eventId } }).catch(() => undefined);
            }
        }
        if (appId) await fetch(`${BASE}/api/applications?id=${appId}`, { method: "DELETE", headers: { Cookie: cookie } }).catch(() => undefined);
        await prisma.session.delete({ where: { sessionToken } }).catch(() => undefined);
        await prisma.$disconnect();
    }
}

/**
 * THE EXIT PATH LIVES OUT HERE — DO NOT MOVE IT BACK INTO `main()`.
 *
 * This was a live false green: step 1 bails with `return fail(...)` on a
 * non-200, and the summary + `process.exit(1)` used to sit AFTER `main()`'s
 * try/finally, which a `return` inside the try skips. The smoke printed
 * `[FAIL] create application failed` / `0/1 steps passed` and still exited 0
 * (verified 2026-07-29). Hoisting the check into `.then()` makes it
 * unskippable — same fix as the hermetic suite's 0a235be.
 */
function finish(): never {
    console.log(`\n${passes}/${passes + fails} steps passed`);
    if (fails > 0) process.exit(1);
    console.log("All checks passed.");
    process.exit(0);
}

main().then(finish, e => {
    console.error("Unhandled error:", e);
    process.exit(2);
});
