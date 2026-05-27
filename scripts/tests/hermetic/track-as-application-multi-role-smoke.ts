/**
 * Hermetic smoke for the multi-role-per-company dedup chain in
 * lib/postings/track-as-application.ts (2026-05-27).
 *
 * Background — the bug this guards against:
 *   Pre-2026-05-27, the schema's @@unique([userId, normalizedCompany, track])
 *   meant tracking a SECOND Allied Universal posting on the side kanban while
 *   an existing Allied Universal app was on the side kanban threw P2002 →
 *   surfaced as a 500. Real ergonomic loss: companies like Allied Universal
 *   list many distinct roles (Museum Rover, Mall Patrol, Hospital, …) and a
 *   user legitimately wants separate applications per role.
 *
 * What we assert:
 *   1. Same company, DIFFERENT role → NEW Application created. (The fix.)
 *   2. Same company, SAME role, different posting → merge-link branch:
 *      created=false, merged=true, original Application.postingId preserved,
 *      new NOTE event ("Also saw …") recorded, new posting flipped to
 *      status='tracked'.
 *   3. Same company, SAME role, but existing Application has no postingId
 *      (came from manual add or Gmail ingest) → merge-link links: existing
 *      app's postingId gets set, NOTE event title="Tracked from …".
 *   4. Same posting twice → existing idempotent return (case 1 in the chain).
 *      created=false, merged=false.
 *
 *   DATABASE_URL="file:./dev.db" npx tsx scripts/tests/hermetic/track-as-application-multi-role-smoke.ts
 */
import { PrismaClient } from "@prisma/client";
import { randomBytes } from "crypto";

import { trackAsApplication } from "@/lib/postings/track-as-application";

const prisma = new PrismaClient();
let passed = 0;
let failed = 0;
function check(name: string, condition: boolean, detail?: string) {
    if (condition) { console.log(`[PASS] ${name}`); passed++; }
    else { console.error(`[FAIL] ${name}${detail ? ` — ${detail}` : ""}`); failed++; }
}

async function main() {
    const tag = randomBytes(4).toString("hex");
    const userId = `multi-role-smoke-${tag}`;
    const watchlistIds: string[] = [];
    const applicationIds: string[] = [];

    try {
        await prisma.user.create({ data: { id: userId, email: `multi-role-smoke-${tag}@example.invalid` } });

        const watchlist = await prisma.watchlist.create({
            data: {
                userId,
                name: `Multi role smoke ${tag}`,
                kind: "keyword",
                track: "side",
                config: JSON.stringify({ kind: "keyword", query: "security officer", locations: ["Los Angeles"] }),
                scheduleMinutes: 60,
            },
        });
        watchlistIds.push(watchlist.id);

        // ─── Case 1: same company, DIFFERENT role → two apps ─────────────
        const postingA = await prisma.jobPosting.create({
            data: {
                watchlistId: watchlist.id,
                externalId: `multirole-${tag}-A`,
                company: "Allied Universal",
                title: "Security Officer Part Time Museum Rover",
                sourceUrl: "https://example.invalid/jobs/A",
                status: "new",
                raw: JSON.stringify({}),
            },
        });
        const postingB = await prisma.jobPosting.create({
            data: {
                watchlistId: watchlist.id,
                externalId: `multirole-${tag}-B`,
                company: "Allied Universal",
                title: "Security Officer Mall Patrol",
                sourceUrl: "https://example.invalid/jobs/B",
                status: "new",
                raw: JSON.stringify({}),
            },
        });

        const ra = await trackAsApplication(userId, postingA.id);
        check("case 1: posting A created an app", ra.ok && ra.created === true, JSON.stringify(ra));
        if (ra.ok) applicationIds.push(ra.applicationId);

        const rb = await trackAsApplication(userId, postingB.id);
        check("case 1: posting B (different role) also created an app", rb.ok && rb.created === true, JSON.stringify(rb));
        check("case 1: rb.merged is false (clean create, not merge-link)", rb.ok && rb.merged === false);
        if (rb.ok) applicationIds.push(rb.applicationId);

        check("case 1: distinct applicationIds", ra.ok && rb.ok && ra.applicationId !== rb.applicationId);

        const appsAtAllied = await prisma.application.findMany({
            where: { userId, normalizedCompany: "Allied Universal", track: "side" },
            select: { id: true, role: true, normalizedRole: true, postingId: true, sourceJobId: true },
        });
        check("case 1: exactly 2 Allied Universal apps on side kanban", appsAtAllied.length === 2, `got ${appsAtAllied.length}`);
        const normalizedRoles = appsAtAllied.map(a => a.normalizedRole).sort();
        check(
            "case 1: normalizedRoles distinguish the two apps",
            JSON.stringify(normalizedRoles) === JSON.stringify(["security officer mall patrol", "security officer museum rover"]),
            `got ${JSON.stringify(normalizedRoles)}`,
        );
        for (const app of appsAtAllied) {
            check(`case 1: app ${app.id} has sourceJobId populated`, app.sourceJobId !== null);
        }

        // ─── Case 2: same company, SAME role, different posting → merge-link ─
        const postingC = await prisma.jobPosting.create({
            data: {
                watchlistId: watchlist.id,
                externalId: `multirole-${tag}-C`,
                company: "Allied Universal",
                // Same normalized role as postingA: "security officer museum rover".
                title: "Security Officer (Museum Rover) - Part-Time",
                sourceUrl: "https://example.invalid/jobs/C",
                status: "new",
                raw: JSON.stringify({}),
            },
        });
        const rc = await trackAsApplication(userId, postingC.id);
        check("case 2: ok response", rc.ok, JSON.stringify(rc));
        check("case 2: created=false (merged into existing)", rc.ok && rc.created === false);
        check("case 2: merged=true", rc.ok && rc.merged === true);
        check("case 2: returns the same applicationId as posting A", rc.ok && ra.ok && rc.applicationId === ra.applicationId);

        // Original Application.postingId must remain pointing at postingA,
        // NOT the new postingC.
        const appAAfter = ra.ok ? await prisma.application.findUnique({ where: { id: ra.applicationId } }) : null;
        check("case 2: existing app's postingId preserved (NOT overwritten)", appAAfter?.postingId === postingA.id);

        // Posting C flipped to tracked.
        const postingCAfter = await prisma.jobPosting.findUnique({ where: { id: postingC.id } });
        check("case 2: posting C flipped to 'tracked'", postingCAfter?.status === "tracked");

        // NOTE event "Also saw …" added to the original app.
        const eventsOnAppA = ra.ok ? await prisma.applicationEvent.findMany({
            where: { applicationId: ra.applicationId },
            orderBy: { createdAt: "asc" },
        }) : [];
        check("case 2: exactly 2 events on the original app (initial + merge-link)", eventsOnAppA.length === 2, `got ${eventsOnAppA.length}`);
        const mergeEvent = eventsOnAppA[1];
        check("case 2: merge-link event title starts with 'Also saw'", mergeEvent?.title?.startsWith("Also saw") === true, `got ${JSON.stringify(mergeEvent?.title)}`);
        check("case 2: merge-link event notes carries new posting URL", mergeEvent?.notes === postingC.sourceUrl);

        // No new Application row created.
        const appsAtAlliedAfter = await prisma.application.count({
            where: { userId, normalizedCompany: "Allied Universal", track: "side" },
        });
        check("case 2: still only 2 Allied apps (no duplicate created)", appsAtAlliedAfter === 2, `got ${appsAtAlliedAfter}`);

        // ─── Case 3: existing app has NULL postingId → merge-link links it ──
        // Simulate a Gmail-ingested app with no posting linkage.
        const otherWatchlist = await prisma.watchlist.create({
            data: {
                userId,
                name: `Other side WL ${tag}`,
                kind: "keyword",
                track: "side",
                config: JSON.stringify({ kind: "keyword", query: "barista", locations: ["LA"] }),
                scheduleMinutes: 60,
            },
        });
        watchlistIds.push(otherWatchlist.id);
        const postingD = await prisma.jobPosting.create({
            data: {
                watchlistId: otherWatchlist.id,
                externalId: `multirole-${tag}-D`,
                company: "Coffee Bean",
                title: "Barista",
                sourceUrl: "https://example.invalid/jobs/D",
                status: "new",
                raw: JSON.stringify({}),
            },
        });
        // Pre-create a manual app for "Coffee Bean" / "Barista" on side, no postingId.
        const manualApp = await prisma.application.create({
            data: {
                userId,
                company: "Coffee Bean",
                normalizedCompany: "Coffee Bean",
                role: "Barista",
                normalizedRole: "barista",
                status: "INTERESTED",
                kind: "job",
                track: "side",
                lastUpdateAt: new Date(),
            },
        });
        applicationIds.push(manualApp.id);

        const rd = await trackAsApplication(userId, postingD.id);
        check("case 3: ok response", rd.ok, JSON.stringify(rd));
        check("case 3: created=false (merged into manual app)", rd.ok && rd.created === false);
        check("case 3: merged=true", rd.ok && rd.merged === true);
        check("case 3: applicationId is the manual app's id", rd.ok && rd.applicationId === manualApp.id);

        const manualAppAfter = await prisma.application.findUnique({ where: { id: manualApp.id } });
        check("case 3: manual app now linked to posting D", manualAppAfter?.postingId === postingD.id);
        check("case 3: manual app got sourceJobId stamped from posting.externalId", manualAppAfter?.sourceJobId === postingD.externalId);

        // ─── Case 4: same posting twice → original idempotent path ─────────
        const reRa = await trackAsApplication(userId, postingA.id);
        check("case 4: same posting twice ok", reRa.ok);
        check("case 4: created=false", reRa.ok && reRa.created === false);
        check("case 4: merged=false (idempotent, not merge-link)", reRa.ok && reRa.merged === false);
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
        console.log(`\n${passed}/${passed + failed} steps passed`);
    }
    if (failed > 0) process.exit(1);
}

main().catch(e => {
    console.error("Unhandled error:", e);
    process.exit(2);
});
