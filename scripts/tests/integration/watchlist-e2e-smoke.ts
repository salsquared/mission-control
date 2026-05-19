/**
 * End-to-end smoke for MB Phase 1 (watchlists + crawler + notifications).
 *
 *   DATABASE_URL="file:./dev.db" npx tsx scripts/tests/integration/watchlist-e2e-smoke.ts
 *
 * Targets Anthropic's Greenhouse board — public JSON API, reliably reachable,
 * 400+ active postings. The smoke creates a watchlist, runs the scheduler
 * synchronously via /api/watchlists/[id]/run, verifies postings + notifications
 * landed, verifies dedupe on re-run, exercises the status PATCH, mark-all-read,
 * and cleans up.
 *
 * If Anthropic's board is unreachable for any reason, the smoke exits cleanly
 * with a skip message — the test environment shouldn't gate on a third party.
 */
import { PrismaClient } from "@prisma/client";
import { randomBytes } from "crypto";

const BASE = process.env.MC_BASE_URL ?? "http://localhost:4101";
const TARGET_BOARD_SLUG = "anthropic";
const TARGET_COMPANY = "Anthropic";
const TARGET_API = `https://boards-api.greenhouse.io/v1/boards/${TARGET_BOARD_SLUG}/jobs`;

const prisma = new PrismaClient();

let passes = 0;
let fails = 0;
function pass(msg: string) { console.log(`[PASS] ${msg}`); passes++; }
function fail(msg: string, detail?: unknown) {
    console.error(`[FAIL] ${msg}`, detail ?? "");
    fails++;
}

async function main() {
    const user = await prisma.user.findFirst();
    if (!user) {
        console.error("No user in dev.db — log in first.");
        process.exit(1);
    }
    console.log(`Using user ${user.email}`);

    // Pre-flight: can we reach the target at all?
    try {
        const ping = await fetch(TARGET_API, { method: "GET", signal: AbortSignal.timeout(8000) });
        if (!ping.ok) {
            console.warn(`[SKIP] target returned HTTP ${ping.status} — skipping smoke without failing.`);
            process.exit(0);
        }
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[SKIP] target unreachable (${msg}) — skipping smoke without failing.`);
        process.exit(0);
    }

    const sessionToken = randomBytes(32).toString("hex");
    await prisma.session.create({
        data: { sessionToken, userId: user.id, expires: new Date(Date.now() + 60 * 60 * 1000) },
    });
    const cookie = `__Secure-next-auth.session-token=${sessionToken}`;
    const headers = { "Content-Type": "application/json", Cookie: cookie };
    let watchlistId = "";
    let createdNotificationIds: string[] = [];
    let createdPostingIds: string[] = [];

    try {
        // 1. POST a watchlist
        {
            const r = await fetch(`${BASE}/api/watchlists`, {
                method: "POST", headers,
                body: JSON.stringify({
                    name: `Smoke — ${TARGET_COMPANY}`,
                    config: {
                        kind: "greenhouse",
                        boardSlug: TARGET_BOARD_SLUG,
                        companyName: TARGET_COMPANY,
                    },
                    scheduleMinutes: 60,
                }),
            });
            const body = await r.json();
            if (r.status !== 200) return fail(`POST /api/watchlists status ${r.status}`, body);
            watchlistId = body.watchlist.id;
            pass(`POST /api/watchlists → ${watchlistId}`);
        }

        // 2. Trigger an immediate run
        let firstRunNew = 0;
        {
            const r = await fetch(`${BASE}/api/watchlists/${watchlistId}/run`, {
                method: "POST", headers: { Cookie: cookie },
            });
            const body = await r.json();
            if (r.status !== 200) return fail(`POST /run status ${r.status}`, body);
            if (body.error) return fail(`/run reported error`, body);
            firstRunNew = body.newPostings;
            console.log(`[verify] first run: ${firstRunNew} new, ${body.seenAgain} seen-again`);
            if (firstRunNew < 1) {
                console.warn(`[SKIP] target returned 0 postings — Rocket Lab careers page structure may have changed.`);
                fail("expected ≥ 1 posting on first run — link pattern likely needs updating");
                return;
            }
            pass(`first run created ${firstRunNew} new postings`);
        }

        // 3. Verify postings landed
        {
            const r = await fetch(`${BASE}/api/postings?watchlistId=${watchlistId}&status=new`, { headers: { Cookie: cookie } });
            const body = await r.json();
            if (r.status !== 200) return fail(`GET postings status ${r.status}`, body);
            if (body.postings.length < 1) return fail(`expected ≥ 1 posting in new feed, got ${body.postings.length}`);
            createdPostingIds = body.postings.map((p: { id: string }) => p.id);
            pass(`GET postings returned ${body.postings.length} rows`);
            console.log(`  Example: ${body.postings[0].company} — ${body.postings[0].title}`);
        }

        // 4. Verify notifications landed
        {
            const r = await fetch(`${BASE}/api/notifications?unread=true`, { headers: { Cookie: cookie } });
            const body = await r.json();
            if (r.status !== 200) return fail(`GET notifications status ${r.status}`, body);
            if (body.unreadCount < 1) return fail(`expected ≥ 1 unread notification, got ${body.unreadCount}`);
            createdNotificationIds = body.notifications.map((n: { id: string }) => n.id);
            pass(`${body.unreadCount} unread notifications after first run`);
        }

        // 5. Trigger a SECOND run — dedup should kick in
        {
            const r = await fetch(`${BASE}/api/watchlists/${watchlistId}/run`, {
                method: "POST", headers: { Cookie: cookie },
            });
            const body = await r.json();
            if (r.status !== 200) return fail(`POST /run (re-run) status ${r.status}`, body);
            console.log(`[verify] second run: ${body.newPostings} new, ${body.seenAgain} seen-again`);
            if (body.newPostings !== 0) fail(`expected 0 new postings on re-run (dedup), got ${body.newPostings}`);
            else pass("re-run created 0 new postings (dedup working)");
            if (body.seenAgain < 1) fail(`expected ≥ 1 seen-again on re-run, got ${body.seenAgain}`);
            else pass(`re-run saw ${body.seenAgain} postings again`);
        }

        // 6. PATCH one posting to "tracked"
        if (createdPostingIds.length > 0) {
            const id = createdPostingIds[0];
            const r = await fetch(`${BASE}/api/postings/${id}`, {
                method: "PATCH", headers,
                body: JSON.stringify({ status: "tracked" }),
            });
            const body = await r.json();
            if (r.status !== 200) return fail(`PATCH posting status ${r.status}`, body);
            if (body.posting.status !== "tracked") fail("PATCH didn't echo new status", body);
            else pass(`PATCH posting → tracked`);

            // It should now be absent from the new feed
            const r2 = await fetch(`${BASE}/api/postings?status=new&watchlistId=${watchlistId}`, { headers: { Cookie: cookie } });
            const b2 = await r2.json();
            if (b2.postings.some((p: { id: string }) => p.id === id)) {
                fail("tracked posting still appears in 'new' feed");
            } else {
                pass("tracked posting no longer in 'new' feed");
            }
        }

        // 7. Mark all notifications read
        {
            const r = await fetch(`${BASE}/api/notifications`, {
                method: "PATCH", headers,
                body: JSON.stringify({ markAllRead: true }),
            });
            const body = await r.json();
            if (r.status !== 200) return fail(`PATCH notifications (markAllRead) status ${r.status}`, body);
            pass(`PATCH markAllRead updated ${body.updated} notifications`);

            const r2 = await fetch(`${BASE}/api/notifications?unread=true`, { headers: { Cookie: cookie } });
            const b2 = await r2.json();
            if (b2.unreadCount !== 0) fail(`expected unreadCount=0 after markAllRead, got ${b2.unreadCount}`);
            else pass("unread count is 0 after markAllRead");
        }

        // 8. Negative — PATCH posting with invalid status
        if (createdPostingIds.length > 0) {
            const r = await fetch(`${BASE}/api/postings/${createdPostingIds[0]}`, {
                method: "PATCH", headers,
                body: JSON.stringify({ status: "garbage" }),
            });
            if (r.status !== 400) fail(`PATCH invalid status expected 400 got ${r.status}`);
            else pass("PATCH posting invalid status → 400");
        }
    } finally {
        // Cleanup — DELETE the watchlist cascades to postings; notifications must be deleted explicitly.
        if (watchlistId) {
            await fetch(`${BASE}/api/watchlists/${watchlistId}`, { method: "DELETE", headers: { Cookie: cookie } }).catch(() => undefined);
        }
        if (createdNotificationIds.length > 0) {
            await prisma.notification.deleteMany({ where: { id: { in: createdNotificationIds } } }).catch(() => undefined);
        }
        await prisma.session.delete({ where: { sessionToken } }).catch(() => undefined);
        await prisma.$disconnect();
        console.log(`\n${passes}/${passes + fails} steps passed`);
        if (fails > 0) process.exit(1);
        console.log("All checks passed.");
    }
}

main().catch(e => {
    console.error("Unhandled error:", e);
    process.exit(2);
});
