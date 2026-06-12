/**
 * Hermetic smoke for the P5.1 job-watcher reconcile sweep
 * (scheduler/jobs/job-watcher.ts:reconcileClosedPostingCascade).
 *
 *   DATABASE_URL="file:./dev.db" EMAIL_ENABLED=0 npx tsx scripts/tests/hermetic/reconcile-cascade-smoke.ts
 *
 * Sibling of cascade-close-smoke.ts (same isolation pattern: throwaway user +
 * watchlist + postings + apps under unique ids, everything cleaned up in
 * finally) but exercising the catch-up sweep rather than the cascade helper
 * itself. The sweep is invoked with its `userId` seam so the pre-push run can
 * never touch real dev.db rows. No network, no PM2, no liveness probe.
 *
 * Asserts:
 *   - an INTERESTED app whose linked posting is status="closed" (a missed
 *     cascade) is reconciled: app → CLOSED + STATUS_CHANGED event with
 *     syncSource="reconcile" at the injected `at`
 *   - a posting in the OQ5a two-tick pending state (pendingClosedAt set,
 *     status still "new") is NOT swept
 *   - an APPLIED app on a closed posting is NOT swept (INTERESTED-only, OQ7)
 *   - an INTERESTED app with no posting linkage is NOT swept
 *   - the userId seam scopes the sweep (another user's qualifying row is
 *     untouched)
 *   - a second run is a no-op (no closes, no duplicate events)
 */
import { PrismaClient } from "@prisma/client";
import { randomBytes } from "crypto";

import { reconcileClosedPostingCascade } from "@/scheduler/jobs/job-watcher";

const prisma = new PrismaClient();

let passes = 0;
let fails = 0;
function pass(msg: string) { console.log(`[PASS] ${msg}`); passes++; }
function fail(msg: string, detail?: unknown) { console.error(`[FAIL] ${msg}`, detail ?? ""); fails++; }

async function main() {
    const tag = randomBytes(4).toString("hex");
    const userId = `reconcile-smoke-user-${tag}`;
    const otherUserId = `reconcile-smoke-other-${tag}`;
    const userIds = [userId, otherUserId];
    const watchlistIds: string[] = [];
    const applicationIds: string[] = [];

    try {
        for (const id of userIds) {
            await prisma.user.create({ data: { id, email: `${id}@example.invalid` } });
        }

        async function mkWatchlist(owner: string) {
            const wl = await prisma.watchlist.create({
                data: {
                    userId: owner,
                    name: `Reconcile smoke ${tag} ${owner === userId ? "main" : "other"}`,
                    kind: "careers-page",
                    config: JSON.stringify({
                        kind: "careers-page",
                        rootUrl: "https://example.invalid/careers/",
                        linkPattern: "/careers/jobs/",
                        companyName: "Reconcile Co",
                    }),
                    scheduleMinutes: 60,
                },
            });
            watchlistIds.push(wl.id);
            return wl;
        }
        const watchlist = await mkWatchlist(userId);
        const otherWatchlist = await mkWatchlist(otherUserId);

        async function mkPosting(wlId: string, slug: string, data: { status: string; pendingClosedAt?: Date; removedAt?: Date }) {
            return prisma.jobPosting.create({
                data: {
                    watchlistId: wlId,
                    externalId: `reconcile-${tag}-${slug}`,
                    company: "Reconcile Co", title: `Role ${slug}`,
                    sourceUrl: `https://example.invalid/careers/jobs/${slug}`,
                    raw: JSON.stringify({}),
                    ...data,
                },
            });
        }
        async function mkApp(owner: string, postingId: string | null, status: string, role: string) {
            const app = await prisma.application.create({
                data: {
                    userId: owner,
                    company: "Reconcile Co",
                    normalizedCompany: "reconcile co",
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

        const closedAt = new Date();
        // (1) Missed cascade: posting fully closed, card still INTERESTED.
        const closedPosting = await mkPosting(watchlist.id, "missed", { status: "closed", removedAt: closedAt });
        const orphanApp = await mkApp(userId, closedPosting.id, "INTERESTED", "Missed Cascade Role");
        // (2) OQ5a pending-only: first strike stamped, close NOT confirmed.
        const pendingPosting = await mkPosting(watchlist.id, "pending", { status: "new", pendingClosedAt: closedAt });
        const pendingApp = await mkApp(userId, pendingPosting.id, "INTERESTED", "Pending Role");
        // (3) Closed posting but the card already progressed past INTERESTED.
        const closedAppliedPosting = await mkPosting(watchlist.id, "applied", { status: "closed", removedAt: closedAt });
        const appliedApp = await mkApp(userId, closedAppliedPosting.id, "APPLIED", "Applied Role");
        // (4) No posting linkage at all.
        const unlinkedApp = await mkApp(userId, null, "INTERESTED", "Unlinked Role");
        // (5) Another user's qualifying row — outside the scoped sweep.
        const otherPosting = await mkPosting(otherWatchlist.id, "other", { status: "closed", removedAt: closedAt });
        const otherApp = await mkApp(otherUserId, otherPosting.id, "INTERESTED", "Other User Role");

        // ─── Run 1: reconcile (scoped to the throwaway user) ───
        const at = new Date();
        const r1 = await reconcileClosedPostingCascade({ userId, at });

        if (r1.closedAppIds.length !== 1) fail(`expected 1 reconciled app, got ${r1.closedAppIds.length}`, r1.closedAppIds);
        else pass("sweep reconciled exactly 1 app");
        if (r1.closedAppIds[0] !== orphanApp.id) fail("reconciled id is not the missed-cascade INTERESTED app");
        else pass("reconciled id is the missed-cascade INTERESTED app");

        const orphanAfter = await prisma.application.findUnique({ where: { id: orphanApp.id } });
        if (orphanAfter?.status !== "CLOSED") fail(`orphan app status ${orphanAfter?.status}, expected CLOSED`);
        else pass("INTERESTED app on closed posting moved to CLOSED");

        const events = await prisma.applicationEvent.findMany({
            where: { applicationId: orphanApp.id, kind: "STATUS_CHANGED" },
        });
        if (events.length !== 1) fail(`expected 1 STATUS_CHANGED event, got ${events.length}`);
        else pass("exactly 1 STATUS_CHANGED event written");
        const ev = events[0];
        if (ev?.syncSource !== "reconcile") fail(`event syncSource ${ev?.syncSource}, expected reconcile`);
        else pass("event carries syncSource=reconcile provenance");
        if (ev?.fromStatus !== "INTERESTED" || ev?.toStatus !== "CLOSED") fail(`event transition ${ev?.fromStatus}→${ev?.toStatus}, expected INTERESTED→CLOSED`);
        else pass("event records INTERESTED → CLOSED");
        if (ev?.occurredAt?.getTime() !== at.getTime()) fail("event occurredAt not pinned to the injected at");
        else pass("event occurredAt pinned to the injected at");

        // ─── pendingClosedAt-only posting NOT swept ───
        const pendingAfter = await prisma.application.findUnique({ where: { id: pendingApp.id } });
        if (pendingAfter?.status !== "INTERESTED") fail(`pending-posting app status ${pendingAfter?.status}, expected INTERESTED`);
        else pass("OQ5a pending-only posting NOT swept (app stays INTERESTED)");
        const pendingPostingAfter = await prisma.jobPosting.findUnique({ where: { id: pendingPosting.id } });
        if (pendingPostingAfter?.status !== "new" || pendingPostingAfter?.pendingClosedAt == null) {
            fail(`pending posting mutated by sweep: status=${pendingPostingAfter?.status} pendingClosedAt=${pendingPostingAfter?.pendingClosedAt}`);
        } else pass("pending posting itself untouched by the sweep");

        // ─── APPLIED app on a closed posting NOT swept (OQ7) ───
        const appliedAfter = await prisma.application.findUnique({ where: { id: appliedApp.id } });
        if (appliedAfter?.status !== "APPLIED") fail(`APPLIED app status ${appliedAfter?.status}, expected untouched APPLIED`);
        else pass("APPLIED app on closed posting NOT swept (INTERESTED-only)");

        // ─── Unlinked INTERESTED app NOT swept ───
        const unlinkedAfter = await prisma.application.findUnique({ where: { id: unlinkedApp.id } });
        if (unlinkedAfter?.status !== "INTERESTED") fail(`unlinked app status ${unlinkedAfter?.status}, expected INTERESTED`);
        else pass("posting-less INTERESTED app NOT swept");

        // ─── userId seam scopes the sweep ───
        const otherAfter = await prisma.application.findUnique({ where: { id: otherApp.id } });
        if (otherAfter?.status !== "INTERESTED") fail(`other user's app status ${otherAfter?.status}, expected INTERESTED (out of scope)`);
        else pass("userId seam keeps another user's qualifying row untouched");

        // ─── Run 2: idempotent no-op ───
        const r2 = await reconcileClosedPostingCascade({ userId, at: new Date() });
        if (r2.closedAppIds.length !== 0) fail(`second run reconciled ${r2.closedAppIds.length} apps, expected 0`);
        else pass("second run is a no-op (nothing further reconciled)");
        const eventsAfter = await prisma.applicationEvent.count({
            where: { applicationId: orphanApp.id, kind: "STATUS_CHANGED" },
        });
        if (eventsAfter !== 1) fail(`second run duplicated events: ${eventsAfter} STATUS_CHANGED, expected 1`);
        else pass("second run did NOT duplicate the STATUS_CHANGED event");
    } finally {
        for (const id of applicationIds) {
            await prisma.applicationEvent.deleteMany({ where: { applicationId: id } }).catch(() => undefined);
            await prisma.application.delete({ where: { id } }).catch(() => undefined);
        }
        for (const id of watchlistIds) {
            await prisma.jobPosting.deleteMany({ where: { watchlistId: id } }).catch(() => undefined);
            await prisma.watchlist.delete({ where: { id } }).catch(() => undefined);
        }
        for (const id of userIds) {
            await prisma.user.delete({ where: { id } }).catch(() => undefined);
        }
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
