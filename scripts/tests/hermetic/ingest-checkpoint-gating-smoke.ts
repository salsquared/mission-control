/**
 * Hermetic smoke for OQ8b checkpoint gating — the throwOnError seam on
 * maybeNotifyForApplicationEvent (lib/repositories/applicationEvents.ts) and
 * syncEventToGcal (lib/calendar/sync.ts) that makes ingest.ts's
 * notifiedAt / gcalSyncedAt stamping live code instead of stamping over
 * swallowed failures.
 *
 * Failure-injection seams (least invasive, no stubs):
 *   - notify REAL failure: dispatch for a NONEXISTENT userId → the
 *     Notification.userId FK violation (P2003) throws out of
 *     prisma.notification.create; dispatchNotification only swallows P2002.
 *   - notify BENIGN no-op: pre-create a Notification carrying the same
 *     `event:<id>` dedupKey → dispatch races into P2002 → returns null
 *     ("already notified" = success, never a throw).
 *   - gcal REAL failure: the throwaway user has no Google Account rows, so
 *     getGoogleAuthClient throws (auth failure).
 *   - gcal BENIGN no-op: an event with no scheduledAt has nothing to mirror.
 *
 * Never sends mail: the REAL-failure path dies before a row exists, the
 * dedup path returns null before the send block, and EMAIL_ENABLED=0 in the
 * pre-push/dev environment regardless. Expect a benign "[gcal-sync] auth
 * failed" + "[applicationEvents] dispatchNotification failed" warn in output.
 *
 *   DATABASE_URL="file:./dev.db" npx tsx scripts/tests/hermetic/ingest-checkpoint-gating-smoke.ts
 */
import { PrismaClient } from "@prisma/client";
import type { ApplicationEvent } from "@prisma/client";
import { maybeNotifyForApplicationEvent } from "@/lib/repositories/applicationEvents";
import { syncEventToGcal } from "@/lib/calendar/sync";

const prisma = new PrismaClient();
const TEST_EMAIL = "ingest-checkpoint-gating-smoke@mission-control.test";

let passes = 0;
let fails = 0;
function check(name: string, cond: boolean, detail?: unknown) {
    if (cond) { console.log(`[PASS] ${name}`); passes++; }
    else { console.error(`[FAIL] ${name}`, detail ?? ""); fails++; }
}

function makeEvent(overrides: Partial<ApplicationEvent> = {}): ApplicationEvent {
    // Fabricated row — never persisted. The notify path only reads fields off
    // the object (Notification.payload has no FK to events/applications), and
    // the gcal paths exercised here fail before any DB write.
    return {
        id: `smoke-ckpt-evt-${Math.random().toString(36).slice(2, 10)}`,
        applicationId: "smoke-ckpt-app",
        kind: "OFFER",
        title: "Offer from Checkpoint Smoke Co",
        occurredAt: new Date(),
        scheduledAt: null,
        endsAt: null,
        fromStatus: null,
        toStatus: null,
        notes: null,
        emailMsgId: "smoke-ckpt-msg",
        gcalEventId: null,
        gcalUpdatedAt: null,
        syncSource: "ms",
        notifiedAt: null,
        gcalSyncedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...overrides,
    } as ApplicationEvent;
}

async function main() {
    // Clean any leftover from a prior failed run (cascade nukes notifications).
    await prisma.user.deleteMany({ where: { email: TEST_EMAIL } }).catch(() => undefined);
    const user = await prisma.user.create({ data: { email: TEST_EMAIL, name: "Checkpoint Smoke" } });
    const ghostUserId = `smoke-no-such-user-${Date.now().toString(36)}`;

    try {
        // ── (a) notify: throwOnError:true RETHROWS a real dispatch failure ──
        {
            const ev = makeEvent();
            let thrown: unknown = null;
            try {
                await maybeNotifyForApplicationEvent(ev, ghostUserId, "Smoke Co", { throwOnError: true });
            } catch (e) {
                thrown = e;
            }
            check("(a) throwOnError:true rethrows when dispatchNotification fails", thrown !== null);
            check(
                "(a) the rethrown error is the injected FK violation (P2003)",
                (thrown as { code?: string } | null)?.code === "P2003",
                thrown,
            );
            const orphanRows = await prisma.notification.count({ where: { userId: ghostUserId } });
            check("(a) no notification row landed for the failed dispatch", orphanRows === 0, orphanRows);
        }

        // ── (c) notify: default (no flag) still swallows the same failure ──
        {
            const ev = makeEvent();
            let thrown: unknown = null;
            try {
                await maybeNotifyForApplicationEvent(ev, ghostUserId, "Smoke Co");
            } catch (e) {
                thrown = e;
            }
            check("(c) default (no flag) swallows the same dispatch failure", thrown === null, thrown);
        }

        // ── (b) notify: dedup-null is BENIGN — no throw even with the flag ──
        {
            const ev = makeEvent();
            const preexisting = await prisma.notification.create({
                data: {
                    userId: user.id,
                    kind: "application",
                    tier: "critical",
                    title: "[checkpoint smoke] pre-existing delivery",
                    payload: "{}",
                    channels: "in_app",
                    dedupKey: `event:${ev.id}`,
                },
            });
            let thrown: unknown = null;
            try {
                await maybeNotifyForApplicationEvent(ev, user.id, "Smoke Co", { throwOnError: true });
            } catch (e) {
                thrown = e;
            }
            check("(b) dedupKey collision (already notified) does NOT throw with throwOnError:true", thrown === null, thrown);
            const rows = await prisma.notification.findMany({ where: { dedupKey: `event:${ev.id}` } });
            check("(b) exactly one row holds the dedupKey (the pre-existing one)",
                rows.length === 1 && rows[0].id === preexisting.id, rows.map(r => r.id));
        }

        // ── (d) gcal: throwOnError taxonomy ─────────────────────────────────
        {
            const futureEv = makeEvent({
                kind: "INTERVIEW_SCHEDULED",
                scheduledAt: new Date(Date.now() + 86_400_000),
            });
            // Real failure: throwaway user has no Google Account rows → auth throws.
            let thrown: unknown = null;
            try {
                await syncEventToGcal(user.id, futureEv, { company: "Smoke Co" }, { throwOnError: true });
            } catch (e) {
                thrown = e;
            }
            check("(d) syncEventToGcal throwOnError:true rethrows on auth failure", thrown !== null);
            check(
                "(d) the rethrown error is the auth failure",
                /not linked|refresh token/i.test((thrown as Error | null)?.message ?? ""),
                thrown,
            );

            // Benign no-op: nothing scheduled → null, no throw, even with the flag.
            const unscheduledEv = makeEvent({ scheduledAt: null });
            const res = await syncEventToGcal(user.id, unscheduledEv, { company: "Smoke Co" }, { throwOnError: true });
            check("(d) no-scheduledAt event returns null without throwing (throwOnError:true)", res === null, res);

            // Default behavior unchanged: same auth failure is swallowed → null.
            const swallowed = await syncEventToGcal(user.id, futureEv, { company: "Smoke Co" });
            check("(d) default (no flag) still swallows the auth failure → null", swallowed === null, swallowed);
        }
    } finally {
        await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
        await prisma.notification.deleteMany({ where: { userId: ghostUserId } }).catch(() => undefined);
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
