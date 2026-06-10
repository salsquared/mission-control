/**
 * Hermetic smoke for closed-jobs P2.2.3 — a manually-closed but still-listed
 * JobPosting is STICKY: the close-detection machinery neither revives it nor
 * re-probes it.
 *
 *   DATABASE_URL="file:./dev.db" npx tsx scripts/tests/hermetic/closed-posting-sticky-smoke.ts
 *
 * This documents (not builds — there is no new guard) the two data-model
 * invariants that make stickiness work. It deliberately does NOT import
 * scheduler/jobs/job-watcher.ts (another track owns it): instead it replicates
 * the two SQL shapes the watcher uses, directly, and asserts the behavior.
 *
 *   (a) STALE-CANDIDATE SELECTION excludes closed rows. The watcher selects
 *       stale candidates with `status NOT IN ('closed','hidden') AND
 *       lastSeenAt < (now - 6h)` (scheduler/jobs/job-watcher.ts ~:466). We
 *       replicate that exact WHERE and assert a closed row that is BOTH closed
 *       AND old enough to be stale is NOT returned — so the close-detection
 *       probe never even looks at it.
 *
 *   (b) THE SEEN-AGAIN PATH bumps lastSeenAt only, never status (watcher
 *       ~:330). We replicate it (update lastSeenAt, leave status untouched) and
 *       assert the row is still 'closed' afterward — so a manually-closed
 *       posting that reappears in the source feed is NOT revived to 'new'.
 *
 * Throwaway watchlist + postings with unique ids (concurrent-safe); full
 * cleanup in finally.
 *
 * No HTTP / no session / no scheduler import.
 */
import { PrismaClient } from "@prisma/client";
import { randomBytes } from "crypto";

const prisma = new PrismaClient();
let passes = 0;
let fails = 0;
function pass(msg: string) { console.log(`[PASS] ${msg}`); passes++; }
function fail(msg: string, detail?: unknown) { console.error(`[FAIL] ${msg}`, detail ?? ""); fails++; }

async function main() {
    const tag = randomBytes(4).toString("hex");
    const userId = `closed-sticky-smoke-${tag}`;
    const watchlistId = `closed-sticky-wl-${tag}`;
    const closedId = `closed-sticky-closed-${tag}`;
    const newId = `closed-sticky-new-${tag}`;

    try {
        await prisma.user.create({ data: { id: userId, email: `closed-sticky-${tag}@example.invalid` } });
        await prisma.watchlist.create({
            data: {
                id: watchlistId,
                userId,
                name: `closed-sticky ${tag}`,
                kind: "careers-page",
                config: "{}",
                track: "career",
            },
        });

        const tenHoursAgo = new Date(Date.now() - 10 * 60 * 60 * 1000);
        const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000);

        // The closed-but-still-listed row: status='closed' AND lastSeenAt old
        // enough to be a stale candidate if status didn't exclude it. This is
        // exactly the manually-closed-but-still-in-feed shape.
        await prisma.jobPosting.create({
            data: {
                id: closedId,
                watchlistId,
                externalId: `ext-closed-${tag}`,
                company: "Sticky Co",
                title: "Closed Role",
                sourceUrl: `https://example.invalid/closed-${tag}`,
                status: "closed",
                lastSeenAt: tenHoursAgo,
                raw: "{}",
            },
        });
        // A control 'new' row, also stale-old, that SHOULD be selected — proves
        // the WHERE clause works (status is what excludes the closed row, not
        // some unrelated bug filtering everything out).
        await prisma.jobPosting.create({
            data: {
                id: newId,
                watchlistId,
                externalId: `ext-new-${tag}`,
                company: "Sticky Co",
                title: "Open Role",
                sourceUrl: `https://example.invalid/new-${tag}`,
                status: "new",
                lastSeenAt: tenHoursAgo,
                raw: "{}",
            },
        });

        // ── (a) Stale-candidate selection excludes closed ──────────────────
        // Replicates scheduler/jobs/job-watcher.ts stale-candidate WHERE.
        const staleCandidates = await prisma.jobPosting.findMany({
            where: {
                watchlistId,
                status: { notIn: ["closed", "hidden"] },
                lastSeenAt: { lt: sixHoursAgo },
            },
            select: { id: true, status: true },
        });
        const staleIds = new Set(staleCandidates.map(c => c.id));

        if (staleIds.has(closedId)) {
            fail("(a) closed row was returned by stale-candidate selection — it must be excluded");
        } else {
            pass("(a) closed row is excluded from stale-candidate selection (never probed)");
        }
        if (staleIds.has(newId)) {
            pass("(a) control 'new' stale row IS selected (WHERE clause is live, not vacuously empty)");
        } else {
            fail("(a) control 'new' stale row should have been selected", { staleIds: [...staleIds] });
        }

        // ── (b) Seen-again bumps lastSeenAt only, never status ──────────────
        const before = await prisma.jobPosting.findUniqueOrThrow({
            where: { id: closedId },
            select: { status: true, lastSeenAt: true },
        });
        const bumpTo = new Date();
        // Replicates the watcher's seen-again update: lastSeenAt only.
        await prisma.jobPosting.update({
            where: { id: closedId },
            data: { lastSeenAt: bumpTo },
        });
        const after = await prisma.jobPosting.findUniqueOrThrow({
            where: { id: closedId },
            select: { status: true, lastSeenAt: true },
        });

        if (after.status !== "closed") {
            fail(`(b) seen-again must not change status — was 'closed', now '${after.status}'`);
        } else {
            pass("(b) seen-again leaves status='closed' (not revived to 'new')");
        }
        if (after.lastSeenAt.getTime() > before.lastSeenAt.getTime()) {
            pass("(b) seen-again did bump lastSeenAt forward");
        } else {
            fail("(b) seen-again should have bumped lastSeenAt forward", { before: before.lastSeenAt, after: after.lastSeenAt });
        }

        // ── (b-followup) Even after the bump, the row stays out of stale
        // selection — bumping lastSeenAt re-arms the 6h clock too, so it's
        // doubly excluded (status AND freshness). Re-run the stale WHERE.
        const staleAfterBump = await prisma.jobPosting.findMany({
            where: {
                watchlistId,
                status: { notIn: ["closed", "hidden"] },
                lastSeenAt: { lt: sixHoursAgo },
            },
            select: { id: true },
        });
        if (staleAfterBump.some(c => c.id === closedId)) {
            fail("(b) closed row reappeared in stale selection after lastSeenAt bump");
        } else {
            pass("(b) closed row stays excluded from stale selection after the bump");
        }
    } finally {
        // Postings cascade-delete with the watchlist; delete explicitly anyway
        // to be safe across schema changes, then the watchlist + user.
        await prisma.jobPosting.deleteMany({ where: { watchlistId } }).catch(() => undefined);
        await prisma.watchlist.delete({ where: { id: watchlistId } }).catch(() => undefined);
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
