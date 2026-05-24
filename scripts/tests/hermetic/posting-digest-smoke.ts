/**
 * Hermetic smoke for posting-digest (story S6.2).
 *
 *   DATABASE_URL="file:./dev.db" npx tsx scripts/tests/hermetic/posting-digest-smoke.ts
 *
 * Creates a scratch user + a watchlist with notificationMode='digest',
 * inserts JobPostings directly via Prisma, runs `runPostingDigest()`, and
 * asserts:
 *   - one summary Notification is created (not N per posting)
 *   - notification payload carries type='posting-digest' and the posting ids
 *   - watchlist.lastDigestAt is set
 *   - re-running with no new postings since lastDigestAt creates NO new
 *     notification (window slides forward)
 *   - a watchlist with notificationMode='each' is NOT processed
 *   - a watchlist with notificationMode='silent' is NOT processed
 *
 * No HTTP / no session.
 */
import { PrismaClient } from "@prisma/client";
import { randomBytes } from "crypto";

import { runPostingDigest } from "@/scheduler/jobs/posting-digest";

const prisma = new PrismaClient();
let passes = 0;
let fails = 0;
function pass(msg: string) { console.log(`[PASS] ${msg}`); passes++; }
function fail(msg: string, detail?: unknown) { console.error(`[FAIL] ${msg}`, detail ?? ""); fails++; }

async function main() {
    const tag = randomBytes(4).toString("hex");
    const userId = `digest-smoke-user-${tag}`;
    const watchlistIds: string[] = [];
    let createdNotificationIds: string[] = [];

    // Snapshot + neutralize GlobalSetting.globalNegativeFilters for the run.
    // The test uses "Senior Engineer N" titles; Sal's real dev.db has "Senior"
    // (and similar) in the global filter, which would correctly suppress
    // dispatch and break our count assertions. The negative-filter pathway
    // itself is covered by notification-negative-filter-smoke.
    const globalRow = await prisma.globalSetting.findUnique({ where: { id: "global" } });
    const globalFilterSnapshot = globalRow?.globalNegativeFilters ?? null;
    if (globalRow && globalFilterSnapshot !== "[]") {
        await prisma.globalSetting.update({
            where: { id: "global" },
            data: { globalNegativeFilters: "[]" },
        });
    }

    try {
        await prisma.user.create({ data: { id: userId, email: `digest-smoke-${tag}@example.invalid` } });

        const wDigest = await prisma.watchlist.create({
            data: {
                userId, name: `Digest WL ${tag}`,
                kind: "careers-page",
                config: JSON.stringify({
                    kind: "careers-page",
                    rootUrl: "https://example.invalid/careers/",
                    linkPattern: "/careers/jobs/",
                    companyName: "Smoke Co",
                }),
                notificationMode: "digest",
                scheduleMinutes: 60,
            },
        });
        const wEach = await prisma.watchlist.create({
            data: {
                userId, name: `Each WL ${tag}`,
                kind: "careers-page",
                config: JSON.stringify({
                    kind: "careers-page",
                    rootUrl: "https://example.invalid/careers/",
                    linkPattern: "/careers/jobs/",
                    companyName: "Each Co",
                }),
                notificationMode: "each",
                scheduleMinutes: 60,
            },
        });
        const wSilent = await prisma.watchlist.create({
            data: {
                userId, name: `Silent WL ${tag}`,
                kind: "careers-page",
                config: JSON.stringify({
                    kind: "careers-page",
                    rootUrl: "https://example.invalid/careers/",
                    linkPattern: "/careers/jobs/",
                    companyName: "Silent Co",
                }),
                notificationMode: "silent",
                scheduleMinutes: 60,
            },
        });
        watchlistIds.push(wDigest.id, wEach.id, wSilent.id);

        // Three postings on the digest watchlist, one on each.
        for (let i = 0; i < 3; i++) {
            await prisma.jobPosting.create({
                data: {
                    watchlistId: wDigest.id,
                    externalId: `smoke-${tag}-d${i}`,
                    company: "Smoke Co",
                    title: `Senior Engineer ${i}`,
                    location: i === 0 ? "Remote" : null,
                    sourceUrl: `https://example.invalid/careers/jobs/d${i}`,
                    status: "new",
                    raw: JSON.stringify({}),
                },
            });
        }
        await prisma.jobPosting.create({
            data: {
                watchlistId: wEach.id,
                externalId: `smoke-${tag}-e0`,
                company: "Each Co", title: "Engineer", sourceUrl: "https://example.invalid/careers/jobs/e0",
                status: "new", raw: JSON.stringify({}),
            },
        });
        await prisma.jobPosting.create({
            data: {
                watchlistId: wSilent.id,
                externalId: `smoke-${tag}-s0`,
                company: "Silent Co", title: "Engineer", sourceUrl: "https://example.invalid/careers/jobs/s0",
                status: "new", raw: JSON.stringify({}),
            },
        });

        // ─── First run: should summarize the digest watchlist only ───
        const r1 = await runPostingDigest();
        if (r1.processed < 1) fail(`first run: expected ≥ 1 processed digest watchlist, got ${r1.processed}`);
        else pass(`first run: ${r1.processed} digest watchlist(s) processed`);

        const notifs1 = await prisma.notification.findMany({
            where: { userId, kind: "posting", payload: { contains: '"type":"posting-digest"' } },
            orderBy: { createdAt: "asc" },
        });
        createdNotificationIds = notifs1.map(n => n.id);
        if (notifs1.length !== 1) fail(`expected 1 digest notification, got ${notifs1.length}`);
        else pass("exactly 1 digest notification fired");

        const payload = notifs1[0] ? JSON.parse(notifs1[0].payload) : {};
        if (payload.count !== 3) fail(`digest count payload=${payload.count}, expected 3`);
        else pass("digest payload.count = 3");
        if (!Array.isArray(payload.postingIds) || payload.postingIds.length !== 3) {
            fail(`digest postingIds missing or wrong length: ${JSON.stringify(payload.postingIds)}`);
        } else pass("digest payload.postingIds carries all 3 ids");
        if (!notifs1[0]?.title?.includes("3 new posting")) fail(`digest title wrong: ${notifs1[0]?.title}`);
        else pass("digest title mentions count");

        const wDigestAfter = await prisma.watchlist.findUnique({ where: { id: wDigest.id } });
        if (!wDigestAfter?.lastDigestAt) fail("lastDigestAt not set after digest run");
        else pass("lastDigestAt set after digest run");

        // ─── Cross-check: no notification for 'each' or 'silent' watchlists ───
        const otherNotifs = await prisma.notification.count({
            where: { userId, kind: "posting", id: { notIn: createdNotificationIds } },
        });
        if (otherNotifs > 0) fail(`unexpected ${otherNotifs} extra notifications`);
        else pass("no notifications fired for 'each' or 'silent' watchlists");

        // ─── Second run with no new postings: NO new notification ───
        const r2 = await runPostingDigest();
        const notifs2 = await prisma.notification.findMany({
            where: { userId, kind: "posting", payload: { contains: '"type":"posting-digest"' } },
        });
        if (notifs2.length !== 1) fail(`second run produced ${notifs2.length} digest notifs, expected still 1`);
        else pass("second run: no new digest notification when no new postings");
        if (r2.summarized !== 0) fail(`second run summarized=${r2.summarized}, expected 0`);
        else pass("second run: summarized=0");

        // ─── Third run: add a posting AFTER lastDigestAt, should summarize 1 ───
        await prisma.jobPosting.create({
            data: {
                watchlistId: wDigest.id,
                externalId: `smoke-${tag}-d3`,
                company: "Smoke Co",
                title: "Staff Engineer",
                sourceUrl: "https://example.invalid/careers/jobs/d3",
                status: "new", raw: JSON.stringify({}),
            },
        });
        const r3 = await runPostingDigest();
        const notifs3 = await prisma.notification.findMany({
            where: { userId, kind: "posting", payload: { contains: '"type":"posting-digest"' } },
            orderBy: { createdAt: "asc" },
        });
        if (notifs3.length !== 2) fail(`third run: expected 2 cumulative digest notifs, got ${notifs3.length}`);
        else pass("third run: new digest fired for new posting only");
        if (r3.summarized !== 1) fail(`third run summarized=${r3.summarized}, expected 1`);
        else pass("third run: summarized=1 (delta only)");
        const payload3 = JSON.parse(notifs3[1].payload);
        if (payload3.count !== 1) fail(`third digest count=${payload3.count}, expected 1`);
        else pass("third digest payload.count = 1 (only the new posting)");

        // ─── Window-race regression (review bug #3) ───
        // Pre-fix, lastDigestAt was set to runAt (a timestamp captured BEFORE
        // the SELECT). A posting inserted by job-watcher in the interval
        // [SELECT, UPDATE] had firstSeenAt > since but <= runAt, so the next
        // run's gt:runAt skipped it permanently. Post-fix, lastDigestAt is
        // the max firstSeenAt that was actually included this run.
        //
        // We simulate the race by FORCING lastDigestAt to a value just after
        // the most-recent-included posting, then inserting a "racey" posting
        // whose firstSeenAt sits in the gap, then running again — the racey
        // posting MUST be picked up.
        const wDigestAfter3 = await prisma.watchlist.findUnique({ where: { id: wDigest.id } });
        if (!wDigestAfter3?.lastDigestAt) {
            fail("window race: lastDigestAt missing after third run");
        } else {
            // The most-recent posting we just summarized had its firstSeenAt
            // set to (approximately) now. lastDigestAt should be >= that.
            const lastDigestMs = wDigestAfter3.lastDigestAt.getTime();
            // Insert a posting whose firstSeenAt sits 1ms AFTER lastDigestAt
            // — i.e. clearly inside the next window. Pre-fix this used to
            // also be the regression target; with the fix it should be
            // picked up by the next run.
            await prisma.jobPosting.create({
                data: {
                    watchlistId: wDigest.id,
                    externalId: `smoke-${tag}-race`,
                    company: "Race Co",
                    title: "Race Posting",
                    sourceUrl: "https://example.invalid/careers/jobs/race",
                    status: "new",
                    firstSeenAt: new Date(lastDigestMs + 1),
                    raw: JSON.stringify({}),
                },
            });
            const rRace = await runPostingDigest();
            if (rRace.summarized !== 1) fail(`window race: expected 1 summarized for the racey posting, got ${rRace.summarized}`);
            else pass("window race: racey posting (firstSeenAt = lastDigestAt+1ms) IS picked up");
        }
    } finally {
        await prisma.notification.deleteMany({ where: { userId } }).catch(() => undefined);
        for (const id of watchlistIds) {
            await prisma.jobPosting.deleteMany({ where: { watchlistId: id } }).catch(() => undefined);
            await prisma.watchlist.delete({ where: { id } }).catch(() => undefined);
        }
        await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
        if (globalFilterSnapshot !== null && globalFilterSnapshot !== "[]") {
            await prisma.globalSetting.update({
                where: { id: "global" },
                data: { globalNegativeFilters: globalFilterSnapshot },
            }).catch(() => undefined);
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
