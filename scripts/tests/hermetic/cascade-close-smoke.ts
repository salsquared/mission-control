/**
 * Hermetic smoke for the closed-jobs Pillar C → A cascade (P4.5).
 *
 *   DATABASE_URL="file:./dev.db" EMAIL_ENABLED=0 npx tsx scripts/tests/hermetic/cascade-close-smoke.ts
 *
 * Exercises lib/applications/close-from-posting.ts:closeApplicationsForClosedPostings
 * directly via Prisma (no HTTP, no PM2, no liveness probe — Track A's smoke must
 * not import another track's file). Throwaway user + watchlist + postings +
 * linked applications with unique ids, so it's safe to run concurrently against
 * dev.db. Asserts:
 *   - a linked INTERESTED app → CLOSED with a STATUS_CHANGED event (OQ7)
 *   - a linked APPLIED app is untouched (cascade is INTERESTED-only)
 *   - an app linked to an unrelated posting is untouched
 *   - an app whose posting id IS passed in but whose posting is NOT actually
 *     status="closed" is untouched (2026-08-02). `postingIds` is a request, not
 *     a licence: job-watcher's confirm UPDATE can reject (a concurrent run
 *     cleared the pending stamp on alive evidence, or the user hit "Hide"
 *     mid-probe-round) and correctly report closed=0, yet it still hands the
 *     UNFILTERED id list to the cascade. Without the posting-status guard the
 *     kanban card moved INTERESTED → CLOSED off a close that never happened —
 *     silently, since the closure notification is gated on closed > 0.
 *   - re-running the cascade is idempotent (no second event, app stays CLOSED)
 *   - the event carries the supplied syncSource provenance
 *
 * Everything cleaned up in finally.
 */
import { PrismaClient } from "@prisma/client";
import { randomBytes } from "crypto";

import { closeApplicationsForClosedPostings } from "@/lib/applications/close-from-posting";

const prisma = new PrismaClient();

let passes = 0;
let fails = 0;
function pass(msg: string) { console.log(`[PASS] ${msg}`); passes++; }
function fail(msg: string, detail?: unknown) { console.error(`[FAIL] ${msg}`, detail ?? ""); fails++; }

async function main() {
    const tag = randomBytes(4).toString("hex");
    const userId = `cascade-smoke-user-${tag}`;
    const watchlistIds: string[] = [];
    const applicationIds: string[] = [];

    try {
        await prisma.user.create({ data: { id: userId, email: `cascade-smoke-${tag}@example.invalid` } });

        const watchlist = await prisma.watchlist.create({
            data: {
                userId,
                name: `Cascade smoke ${tag}`,
                kind: "careers-page",
                config: JSON.stringify({
                    kind: "careers-page",
                    rootUrl: "https://example.invalid/careers/",
                    linkPattern: "/careers/jobs/",
                    companyName: "Cascade Co",
                }),
                scheduleMinutes: 60,
            },
        });
        watchlistIds.push(watchlist.id);

        // Two CONFIRMED-CLOSED postings (one with an INTERESTED app, one with
        // an APPLIED app) — every caller flips the row before calling, so
        // status="closed" is the real precondition, not decoration. Plus two
        // still-open ones: `unrelatedPosting` (never passed to the cascade) and
        // `notActuallyClosedPosting` (passed in, but still open — the caller
        // ASKED to close it and the UPDATE rejected).
        const closingPostingInterested = await prisma.jobPosting.create({
            data: {
                watchlistId: watchlist.id,
                externalId: `cascade-${tag}-int`,
                company: "Cascade Co", title: "Interested Role",
                sourceUrl: "https://example.invalid/careers/jobs/int",
                status: "closed", removedAt: new Date(), raw: JSON.stringify({}),
            },
        });
        const closingPostingApplied = await prisma.jobPosting.create({
            data: {
                watchlistId: watchlist.id,
                externalId: `cascade-${tag}-app`,
                company: "Cascade Co", title: "Applied Role",
                sourceUrl: "https://example.invalid/careers/jobs/app",
                status: "closed", removedAt: new Date(), raw: JSON.stringify({}),
            },
        });
        const unrelatedPosting = await prisma.jobPosting.create({
            data: {
                watchlistId: watchlist.id,
                externalId: `cascade-${tag}-unr`,
                company: "Cascade Co", title: "Unrelated Role",
                sourceUrl: "https://example.invalid/careers/jobs/unr",
                status: "new", raw: JSON.stringify({}),
            },
        });
        // Still "new" — models the confirm UPDATE rejecting (concurrent alive
        // evidence / a user "Hide") while the caller passes the id anyway.
        const notActuallyClosedPosting = await prisma.jobPosting.create({
            data: {
                watchlistId: watchlist.id,
                externalId: `cascade-${tag}-open`,
                company: "Cascade Co", title: "Still Open Role",
                sourceUrl: "https://example.invalid/careers/jobs/open",
                status: "new", raw: JSON.stringify({}),
            },
        });

        async function mkApp(postingId: string, status: string, role: string) {
            const app = await prisma.application.create({
                data: {
                    userId,
                    company: "Cascade Co",
                    normalizedCompany: "cascade co",
                    normalizedRole: role.toLowerCase(),
                    role,
                    status,
                    track: "career",
                    postingId,
                },
            });
            applicationIds.push(app.id);
            return app;
        }

        const interestedApp = await mkApp(closingPostingInterested.id, "INTERESTED", "Interested Role");
        const appliedApp = await mkApp(closingPostingApplied.id, "APPLIED", "Applied Role");
        const unrelatedApp = await mkApp(unrelatedPosting.id, "INTERESTED", "Unrelated Role");
        const stillOpenApp = await mkApp(notActuallyClosedPosting.id, "INTERESTED", "Still Open Role");

        // ─── Cascade: ask for three posting ids, only two of which are closed ───
        const at = new Date();
        const r1 = await closeApplicationsForClosedPostings(
            [closingPostingInterested.id, closingPostingApplied.id, notActuallyClosedPosting.id],
            { at, source: "probe" },
        );

        // Only the INTERESTED app should be returned + closed.
        if (r1.closedAppIds.length !== 1) fail(`expected 1 closed app id, got ${r1.closedAppIds.length}`, r1.closedAppIds);
        else pass("cascade returned exactly 1 closed app id (INTERESTED only)");
        if (r1.closedAppIds[0] !== interestedApp.id) fail("returned closed id is not the INTERESTED app");
        else pass("returned closed id is the INTERESTED app");

        const intAfter = await prisma.application.findUnique({ where: { id: interestedApp.id } });
        if (intAfter?.status !== "CLOSED") fail(`INTERESTED app status ${intAfter?.status}, expected CLOSED`);
        else pass("INTERESTED app moved to CLOSED");
        if (intAfter?.lastUpdateAt?.getTime() !== at.getTime()) fail(`lastUpdateAt not set to opts.at`);
        else pass("INTERESTED app lastUpdateAt set to opts.at");

        const intEvents = await prisma.applicationEvent.findMany({
            where: { applicationId: interestedApp.id, kind: "STATUS_CHANGED" },
        });
        if (intEvents.length !== 1) fail(`expected 1 STATUS_CHANGED event, got ${intEvents.length}`);
        else pass("exactly 1 STATUS_CHANGED event written for the closed card");
        const ev = intEvents[0];
        if (ev?.fromStatus !== "INTERESTED") fail(`event fromStatus ${ev?.fromStatus}, expected INTERESTED`);
        else pass("event fromStatus=INTERESTED");
        if (ev?.toStatus !== "CLOSED") fail(`event toStatus ${ev?.toStatus}, expected CLOSED`);
        else pass("event toStatus=CLOSED");
        if (ev?.syncSource !== "probe") fail(`event syncSource ${ev?.syncSource}, expected probe`);
        else pass("event syncSource carries provenance (probe)");
        if (ev?.occurredAt?.getTime() !== at.getTime()) fail("event occurredAt not set to opts.at");
        else pass("event occurredAt set to opts.at");

        // ─── APPLIED app untouched (INTERESTED-only, OQ7) ───
        const appAfter = await prisma.application.findUnique({ where: { id: appliedApp.id } });
        if (appAfter?.status !== "APPLIED") fail(`APPLIED app status ${appAfter?.status}, expected untouched APPLIED`);
        else pass("APPLIED app left untouched (INTERESTED-only cascade)");
        const appEvents = await prisma.applicationEvent.count({ where: { applicationId: appliedApp.id } });
        if (appEvents !== 0) fail(`APPLIED app got ${appEvents} events, expected 0`);
        else pass("APPLIED app got no STATUS_CHANGED event");

        // ─── Unrelated app (posting not in the closed set) untouched ───
        const unrAfter = await prisma.application.findUnique({ where: { id: unrelatedApp.id } });
        if (unrAfter?.status !== "INTERESTED") fail(`unrelated app status ${unrAfter?.status}, expected INTERESTED`);
        else pass("unrelated INTERESTED app (posting not closed) left untouched");

        // ─── Confirm guard: id WAS passed, posting is NOT closed → no cascade ───
        const openAfter = await prisma.application.findUnique({ where: { id: stillOpenApp.id } });
        if (openAfter?.status !== "INTERESTED") {
            fail(`app whose posting is still status='new' was closed anyway (${openAfter?.status}) — the cascade trusts postingIds instead of re-reading the posting`);
        } else {
            pass("app linked to a passed-but-still-open posting left untouched (cascade re-reads the posting's status)");
        }
        const openEvents = await prisma.applicationEvent.count({ where: { applicationId: stillOpenApp.id } });
        if (openEvents !== 0) fail(`still-open app got ${openEvents} events, expected 0`);
        else pass("still-open app got no STATUS_CHANGED event");

        // ─── Idempotent: re-running closes nothing, writes no new event ───
        const r2 = await closeApplicationsForClosedPostings(
            [closingPostingInterested.id, closingPostingApplied.id],
            { at: new Date(), source: "probe" },
        );
        if (r2.closedAppIds.length !== 0) fail(`re-run closed ${r2.closedAppIds.length} apps, expected 0`);
        else pass("re-run is idempotent (no further closes)");
        const intEventsAfter = await prisma.applicationEvent.count({
            where: { applicationId: interestedApp.id, kind: "STATUS_CHANGED" },
        });
        if (intEventsAfter !== 1) fail(`re-run duplicated events: ${intEventsAfter} STATUS_CHANGED, expected 1`);
        else pass("re-run did NOT duplicate the STATUS_CHANGED event");

        // ─── Empty input is a no-op ───
        const r3 = await closeApplicationsForClosedPostings([], { at: new Date(), source: "ms" });
        if (r3.closedAppIds.length !== 0) fail("empty input did not no-op");
        else pass("empty postingIds is a no-op");
    } finally {
        for (const id of applicationIds) {
            await prisma.applicationEvent.deleteMany({ where: { applicationId: id } }).catch(() => undefined);
            await prisma.application.delete({ where: { id } }).catch(() => undefined);
        }
        for (const id of watchlistIds) {
            await prisma.jobPosting.deleteMany({ where: { watchlistId: id } }).catch(() => undefined);
            await prisma.watchlist.delete({ where: { id } }).catch(() => undefined);
        }
        await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
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
