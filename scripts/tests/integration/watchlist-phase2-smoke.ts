/**
 * MB Phase 2a smoke — Track→App, Lever + Ashby fetchers, closed detection.
 *
 *   DATABASE_URL="file:./dev.db" npx tsx scripts/tests/integration/watchlist-phase2-smoke.ts
 *
 * Pieces tested:
 *   1. Lever fetcher against `leverdemo` (Lever's own demo board, ~390 jobs)
 *   2. Ashby fetcher against `posthog` (~14 jobs)
 *   3. POST /api/postings/[id]/track-as-application creates an Application,
 *      idempotent on re-call, posting transitions to status='tracked'
 *   4. Closed detection — simulated by manually backdating a posting's
 *      lastSeenAt + deleting it from the watchlist's externalId set
 *
 * All scratch rows are deleted afterwards.
 */
import { PrismaClient } from "@prisma/client";
import { randomBytes } from "crypto";

const BASE = process.env.MC_BASE_URL ?? "http://localhost:4101";
const prisma = new PrismaClient();

let passes = 0;
let fails = 0;
function pass(msg: string) { console.log(`[PASS] ${msg}`); passes++; }
function fail(msg: string, detail?: unknown) { console.error(`[FAIL] ${msg}`, detail ?? ""); fails++; }

async function ensureReachable(url: string, label: string): Promise<boolean> {
    try {
        const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
        return r.ok;
    } catch {
        console.warn(`[SKIP] ${label} unreachable — skipping piece.`);
        return false;
    }
}

async function main() {
    const user = await prisma.user.findFirst();
    if (!user) {
        console.error("No user in dev.db — log in first.");
        process.exit(1);
    }
    console.log(`Using user ${user.email}`);

    const sessionToken = randomBytes(32).toString("hex");
    await prisma.session.create({
        data: { sessionToken, userId: user.id, expires: new Date(Date.now() + 60 * 60 * 1000) },
    });
    const cookie = `__Secure-next-auth.session-token=${sessionToken}`;
    const headers = { "Content-Type": "application/json", Cookie: cookie };

    const watchlistIds: string[] = [];
    const applicationIds: string[] = [];

    try {
        // ─── 1) Lever fetcher ───────────────────────────────────────────────
        if (await ensureReachable("https://api.lever.co/v0/postings/leverdemo", "Lever")) {
            const r = await fetch(`${BASE}/api/watchlists`, {
                method: "POST", headers,
                body: JSON.stringify({
                    name: "Smoke — Lever (leverdemo)",
                    config: { kind: "lever", boardSlug: "leverdemo", companyName: "Lever Demo" },
                    scheduleMinutes: 60,
                }),
            });
            const body = await r.json();
            if (r.status !== 200) { fail(`POST Lever watchlist status ${r.status}`, body); }
            else {
                watchlistIds.push(body.watchlist.id);
                const run = await fetch(`${BASE}/api/watchlists/${body.watchlist.id}/run`, { method: "POST", headers: { Cookie: cookie } });
                const runBody = await run.json();
                if (run.status !== 200 || runBody.error) fail(`Lever run failed`, runBody);
                else if (runBody.newPostings < 50) fail(`Lever expected ≥ 50 postings, got ${runBody.newPostings}`);
                else pass(`Lever fetcher returned ${runBody.newPostings} postings`);
            }
        }

        // ─── 2) Ashby fetcher ───────────────────────────────────────────────
        if (await ensureReachable("https://api.ashbyhq.com/posting-api/job-board/posthog", "Ashby")) {
            const r = await fetch(`${BASE}/api/watchlists`, {
                method: "POST", headers,
                body: JSON.stringify({
                    name: "Smoke — Ashby (posthog)",
                    config: { kind: "ashby", boardSlug: "posthog", companyName: "PostHog" },
                    scheduleMinutes: 60,
                }),
            });
            const body = await r.json();
            if (r.status !== 200) { fail(`POST Ashby watchlist status ${r.status}`, body); }
            else {
                watchlistIds.push(body.watchlist.id);
                const run = await fetch(`${BASE}/api/watchlists/${body.watchlist.id}/run`, { method: "POST", headers: { Cookie: cookie } });
                const runBody = await run.json();
                if (run.status !== 200 || runBody.error) fail(`Ashby run failed`, runBody);
                else if (runBody.newPostings < 1) fail(`Ashby expected ≥ 1 posting, got ${runBody.newPostings}`);
                else pass(`Ashby fetcher returned ${runBody.newPostings} postings`);
            }
        }

        if (watchlistIds.length === 0) {
            console.warn("[SKIP] no fetcher reachable — can't run Track→App or closed tests");
            process.exit(0);
        }

        // ─── 3) Track→App ───────────────────────────────────────────────────
        // Pick any posting from any of the created watchlists
        const firstPosting = await prisma.jobPosting.findFirst({
            where: { watchlistId: { in: watchlistIds } },
        });
        if (!firstPosting) {
            fail("no posting to track-as-application — fetchers may have returned empty");
        } else {
            const r = await fetch(`${BASE}/api/postings/${firstPosting.id}/track-as-application`, {
                method: "POST", headers: { Cookie: cookie },
            });
            const body = await r.json();
            if (r.status !== 200) { fail(`Track→App status ${r.status}`, body); }
            else if (!body.created || !body.application?.id) { fail(`Track→App didn't create`, body); }
            else {
                applicationIds.push(body.application.id);
                if (body.application.status !== "INTERESTED") fail(`Track→App: expected status INTERESTED, got ${body.application.status}`);
                else pass("Track→App created Application with status=INTERESTED");
                if (body.application.postingId !== firstPosting.id) fail("Track→App: postingId mismatch", body.application);
                else pass("Track→App set postingId correctly");
                if (body.posting.status !== "tracked") fail(`Track→App: posting status now ${body.posting.status}, expected tracked`);
                else pass("Track→App flipped posting status to tracked");

                // Idempotency
                const r2 = await fetch(`${BASE}/api/postings/${firstPosting.id}/track-as-application`, {
                    method: "POST", headers: { Cookie: cookie },
                });
                const body2 = await r2.json();
                if (body2.created !== false) fail("Track→App: re-call should set created=false");
                else pass("Track→App idempotent on re-call");
                if (body2.application?.id !== body.application.id) fail("Track→App: re-call returned different application id");
                else pass("Track→App re-call returned the same application");
            }
        }

        // ─── 4) Closed-posting detection ────────────────────────────────────
        // Stage: backdate one posting's lastSeenAt by 7h and mutate its
        // externalId so it WON'T match what the next fetch returns. Then re-run
        // the watchlist — it should land in status='closed'.
        const lever = watchlistIds.find(async () => {
            const w = await prisma.watchlist.findUnique({ where: { id: watchlistIds[0] } });
            return w?.kind === "lever";
        });
        const targetWatchlistId = lever ?? watchlistIds[0];
        // Pick any non-tracked posting from this watchlist
        const closeCandidate = await prisma.jobPosting.findFirst({
            where: { watchlistId: targetWatchlistId, status: "new" },
        });
        if (!closeCandidate) {
            fail("no candidate posting for closed-detection test");
        } else {
            // Backdate + corrupt the externalId so the next run won't recognize it
            const sevenHoursAgo = new Date(Date.now() - 7 * 60 * 60 * 1000);
            await prisma.jobPosting.update({
                where: { id: closeCandidate.id },
                data: {
                    externalId: `__SMOKE_DELETED__${randomBytes(8).toString("hex")}`,
                    lastSeenAt: sevenHoursAgo,
                },
            });
            const r = await fetch(`${BASE}/api/watchlists/${targetWatchlistId}/run`, { method: "POST", headers: { Cookie: cookie } });
            const body = await r.json();
            if (r.status !== 200) fail(`closed-detection re-run status ${r.status}`, body);
            else if (body.closed < 1) fail(`closed-detection: expected ≥ 1 closed, got ${body.closed}`, body);
            else pass(`closed-detection: ${body.closed} posting(s) marked closed on re-run`);

            const after = await prisma.jobPosting.findUnique({ where: { id: closeCandidate.id } });
            if (after?.status !== "closed") fail(`closed-detection: target posting status now ${after?.status}, expected closed`);
            else pass("closed-detection: target posting is status=closed");
            if (!after?.removedAt) fail("closed-detection: removedAt not set");
            else pass("closed-detection: removedAt set");
        }
    } finally {
        for (const id of applicationIds) {
            await prisma.application.delete({ where: { id } }).catch(() => undefined);
        }
        for (const id of watchlistIds) {
            await fetch(`${BASE}/api/watchlists/${id}`, { method: "DELETE", headers: { Cookie: cookie } }).catch(() => undefined);
        }
        // Drop any notifications we created during this run
        await prisma.notification.deleteMany({ where: { userId: user.id, createdAt: { gte: new Date(Date.now() - 5 * 60 * 1000) } } }).catch(() => undefined);
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
