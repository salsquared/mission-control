/**
 * Hermetic smoke for story S5.5: track-as-application.
 *
 *   DATABASE_URL="file:./dev.db" npx tsx scripts/tests/hermetic/track-as-application-smoke.ts
 *
 * Creates a scratch user + watchlist + posting directly via Prisma, then
 * exercises `trackAsApplication(userId, postingId)`:
 *   - first call: creates Application(INTERESTED), writes NOTE event with
 *     sourceUrl, flips posting to status='tracked'
 *   - second call: idempotent — returns the same applicationId with
 *     created=false
 *   - foreign user: a different user's posting returns posting-not-found
 *
 * No HTTP, no PM2. Everything cleaned up in finally.
 */
import { PrismaClient } from "@prisma/client";
import { randomBytes } from "crypto";

import { trackAsApplication } from "@/lib/postings/track-as-application";

const prisma = new PrismaClient();

let passes = 0;
let fails = 0;
function pass(msg: string) { console.log(`[PASS] ${msg}`); passes++; }
function fail(msg: string, detail?: unknown) { console.error(`[FAIL] ${msg}`, detail ?? ""); fails++; }

async function main() {
    const tag = randomBytes(4).toString("hex");
    const userId = `track-smoke-user-${tag}`;
    const otherUserId = `track-smoke-other-${tag}`;
    const watchlistIds: string[] = [];
    const applicationIds: string[] = [];

    try {
        await prisma.user.create({ data: { id: userId, email: `track-smoke-${tag}@example.invalid` } });
        await prisma.user.create({ data: { id: otherUserId, email: `track-smoke-other-${tag}@example.invalid` } });

        const watchlist = await prisma.watchlist.create({
            data: {
                userId,
                name: `Track smoke ${tag}`,
                kind: "careers-page",
                config: JSON.stringify({
                    kind: "careers-page",
                    rootUrl: "https://example.invalid/careers/",
                    linkPattern: "/careers/jobs/",
                    companyName: "Smoke Co",
                }),
                scheduleMinutes: 60,
            },
        });
        watchlistIds.push(watchlist.id);

        const posting = await prisma.jobPosting.create({
            data: {
                watchlistId: watchlist.id,
                externalId: `smoke-${tag}-001`,
                company: "Smoke Co",
                title: "Senior Software Engineer",
                location: "Remote",
                sourceUrl: "https://example.invalid/careers/jobs/001",
                snippet: "Build things.",
                status: "new",
                raw: JSON.stringify({}),
            },
        });

        // ─── First call: creates everything ───
        const r1 = await trackAsApplication(userId, posting.id);
        if (!r1.ok) return fail("first call: posting-not-found unexpected", r1);
        if (!r1.created) fail("first call: expected created=true");
        else pass("first call: created=true");
        if (r1.postingStatus !== "tracked") fail(`first call: posting status now ${r1.postingStatus}, expected 'tracked'`);
        else pass("first call: posting flipped to 'tracked'");
        applicationIds.push(r1.applicationId);

        const appRow = await prisma.application.findUnique({ where: { id: r1.applicationId } });
        if (appRow?.status !== "INTERESTED") fail(`Application status ${appRow?.status}, expected INTERESTED`);
        else pass("Application created with status=INTERESTED");
        if (appRow?.company !== posting.company) fail(`Application company mismatch: ${appRow?.company}`);
        else pass("Application company carried from posting");
        if (appRow?.role !== posting.title) fail(`Application role mismatch: ${appRow?.role}`);
        else pass("Application role carried from posting.title");
        if (appRow?.postingId !== posting.id) fail("Application postingId not set");
        else pass("Application postingId linked back");
        if (appRow?.kind !== "job") fail(`Application kind ${appRow?.kind}, expected 'job'`);
        else pass("Application kind defaults to 'job'");

        const events = await prisma.applicationEvent.findMany({
            where: { applicationId: r1.applicationId },
            orderBy: { createdAt: "asc" },
        });
        if (events.length !== 1) fail(`expected 1 timeline event, got ${events.length}`);
        else pass("exactly 1 timeline event written");
        const ev = events[0];
        if (ev?.kind !== "NOTE") fail(`event kind ${ev?.kind}, expected NOTE`);
        else pass("timeline event kind=NOTE");
        if (!ev?.title?.includes(posting.company)) fail(`event title missing company: ${ev?.title}`);
        else pass("timeline event title references posting company");
        if (ev?.notes !== posting.sourceUrl) fail(`event notes mismatch: ${ev?.notes}`);
        else pass("timeline event notes carries sourceUrl");

        const postingAfter = await prisma.jobPosting.findUnique({ where: { id: posting.id } });
        if (postingAfter?.status !== "tracked") fail(`posting status DB-side ${postingAfter?.status}`);
        else pass("posting status=tracked persisted");

        // ─── Second call: idempotent ───
        const r2 = await trackAsApplication(userId, posting.id);
        if (!r2.ok) return fail("second call: posting-not-found unexpected", r2);
        if (r2.created) fail("second call: expected created=false");
        else pass("second call: created=false (idempotent)");
        if (r2.applicationId !== r1.applicationId) fail("second call returned different applicationId");
        else pass("second call returned same applicationId");

        const eventsAfter = await prisma.applicationEvent.count({ where: { applicationId: r1.applicationId } });
        if (eventsAfter !== 1) fail(`expected 1 event after idempotent re-call, got ${eventsAfter}`);
        else pass("idempotent re-call did NOT duplicate the NOTE event");

        const appCount = await prisma.application.count({ where: { postingId: posting.id, userId } });
        if (appCount !== 1) fail(`expected 1 application for posting, got ${appCount}`);
        else pass("exactly 1 Application row exists for this posting");

        // ─── Cross-user isolation ───
        const r3 = await trackAsApplication(otherUserId, posting.id);
        if (r3.ok) fail("foreign user: expected posting-not-found, got ok");
        else if (r3.reason !== "posting-not-found") fail(`foreign user reason ${r3.reason}`);
        else pass("foreign user: posting-not-found (cross-user isolation)");

        // ─── Unknown posting ───
        const r4 = await trackAsApplication(userId, "nonexistent-posting-id");
        if (r4.ok) fail("unknown posting: expected posting-not-found, got ok");
        else pass("unknown posting id: posting-not-found");

        // ─── TOCTOU race: two concurrent calls must NOT both throw P2002 ───
        // Regression: pre-fix, two parallel trackAsApplication calls on a
        // fresh posting both pass the findFirst check, both transactions
        // race to create, and one throws P2002 (surfaces as 500 from the
        // route). After fix: the loser catches P2002 and resolves to the
        // winner's row with created=false.
        const posting2 = await prisma.jobPosting.create({
            data: {
                watchlistId: watchlist.id,
                externalId: `smoke-${tag}-002`,
                company: "Race Co", title: "Race Engineer",
                sourceUrl: "https://example.invalid/careers/jobs/002",
                status: "new", raw: JSON.stringify({}),
            },
        });
        const [ra, rb] = await Promise.all([
            trackAsApplication(userId, posting2.id),
            trackAsApplication(userId, posting2.id),
        ]);
        if (!ra.ok || !rb.ok) fail(`concurrent race: one call errored — ra=${JSON.stringify(ra)} rb=${JSON.stringify(rb)}`);
        else pass("concurrent race: both calls returned ok");
        const createdCount = [ra, rb].filter(r => r.ok && r.created).length;
        if (createdCount !== 1) fail(`concurrent race: expected exactly 1 created=true, got ${createdCount}`);
        else pass("concurrent race: exactly one call reports created=true");
        if (ra.ok && rb.ok && ra.applicationId !== rb.applicationId) {
            fail("concurrent race: both calls returned different applicationIds — duplicate rows created");
        } else pass("concurrent race: both calls converged on same applicationId");
        const dupRowCount = await prisma.application.count({
            where: { postingId: posting2.id, userId },
        });
        if (dupRowCount !== 1) fail(`concurrent race: ${dupRowCount} Application rows for posting (expected 1)`);
        else pass("concurrent race: exactly 1 Application row in DB");
        if (ra.ok) applicationIds.push(ra.applicationId);
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
        await prisma.user.delete({ where: { id: otherUserId } }).catch(() => undefined);
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
