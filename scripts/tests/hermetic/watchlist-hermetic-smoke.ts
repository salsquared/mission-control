/**
 * Hermetic full-pipeline smoke for the watchlist subsystem.
 *
 *   DATABASE_URL="file:./dev.db" npx tsx scripts/tests/hermetic/watchlist-hermetic-smoke.ts
 *
 * Spins up an in-process HTTP server on a random port serving fixture HTML for
 * a fake careers page. Creates a watchlist directly via Prisma, calls
 * `runWatchlist` from scheduler/jobs/job-watcher, and verifies the full
 * pipeline: fetcher → externalId dedupe → JobPosting upsert → Notification
 * → closed-detection. Mutates the server's fixture between runs to exercise
 * dedup and closure.
 *
 * Does NOT need PM2 or the Next.js dev server. Cleans up all rows on exit.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { AddressInfo } from "net";
import { PrismaClient } from "@prisma/client";

// Test-only: allow fetching the in-process fixture server at 127.0.0.1.
// Production deployments never set this; the SSRF guard in lib/security/url-guard.ts
// rejects private IPs otherwise.
process.env.MC_ALLOW_PRIVATE_FETCH = "1";

import { runWatchlist } from "@/scheduler/jobs/job-watcher";

const prisma = new PrismaClient();

let passes = 0;
let fails = 0;
function pass(msg: string) { console.log(`[PASS] ${msg}`); passes++; }
function fail(msg: string, detail?: unknown) { console.error(`[FAIL] ${msg}`, detail ?? ""); fails++; }

// ─── Fixture server ──────────────────────────────────────────────────────

function htmlForPostings(postings: { slug: string; title: string }[]): string {
    const links = postings.map(p =>
        `<a href="/careers/jobs/${p.slug}">${p.title}</a>`
    ).join("\n");
    return `<!doctype html><html><body>
        <h1>Hermetic Test Careers</h1>
        ${links}
        <a href="/about">About (not a job)</a>
    </body></html>`;
}

class FixtureServer {
    private currentPostings: { slug: string; title: string }[] = [];
    private server: ReturnType<typeof createServer>;
    public port = 0;

    constructor() {
        this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
            if (req.url === "/careers/") {
                res.writeHead(200, { "content-type": "text/html" });
                res.end(htmlForPostings(this.currentPostings));
            } else {
                res.writeHead(404).end("not found");
            }
        });
    }

    async start(): Promise<void> {
        await new Promise<void>(resolve => this.server.listen(0, "127.0.0.1", () => resolve()));
        this.port = (this.server.address() as AddressInfo).port;
    }

    setPostings(postings: { slug: string; title: string }[]) {
        this.currentPostings = postings;
    }

    rootUrl(): string {
        return `http://127.0.0.1:${this.port}/careers/`;
    }

    async stop(): Promise<void> {
        await new Promise<void>(resolve => this.server.close(() => resolve()));
    }
}

// ─── Main ────────────────────────────────────────────────────────────────

async function main() {
    const fixture = new FixtureServer();
    await fixture.start();
    console.log(`[setup] fixture server on ${fixture.rootUrl()}`);

    const user = await prisma.user.findFirst();
    if (!user) {
        console.error("No user in dev.db — log in first.");
        process.exit(1);
    }

    // Snapshot + neutralize GlobalSetting.globalNegativeFilters for the run.
    // Sal's real dev.db has filters like "Senior" / "Manager" that would
    // suppress notifications for the test fixture's "Senior Engineer" /
    // "Product Manager" titles (parity with /api/postings GET). The smoke
    // doesn't care about that path — see notification-negative-filter-smoke
    // for filter behavior — so we clear and restore.
    const globalRow = await prisma.globalSetting.findUnique({ where: { id: "global" } });
    const globalFilterSnapshot = globalRow?.globalNegativeFilters ?? null;
    if (globalRow && globalFilterSnapshot !== "[]") {
        await prisma.globalSetting.update({
            where: { id: "global" },
            data: { globalNegativeFilters: "[]" },
        });
    }

    let watchlistId = "";

    try {
        // Initial fixture: 3 postings
        fixture.setPostings([
            { slug: "100", title: "Senior Engineer" },
            { slug: "200", title: "Designer" },
            { slug: "300", title: "Product Manager" },
        ]);

        // Create watchlist directly via Prisma (avoids needing PM2/session)
        const w = await prisma.watchlist.create({
            data: {
                userId: user.id,
                name: "Hermetic Smoke",
                kind: "careers-page",
                config: JSON.stringify({
                    kind: "careers-page",
                    rootUrl: fixture.rootUrl(),
                    linkPattern: "/careers/jobs/",
                    companyName: "Hermetic Co",
                }),
                scheduleMinutes: 60,
            },
        });
        watchlistId = w.id;
        pass(`created watchlist ${watchlistId}`);

        // ─── First run: 3 new postings ───
        const r1 = await runWatchlist(watchlistId);
        if (r1.error) return fail("first run errored", r1.error);
        if (r1.newPostings !== 3) fail(`first run: expected 3 new postings, got ${r1.newPostings}`);
        else pass("first run: 3 new postings");
        if (r1.seenAgain !== 0) fail(`first run: expected 0 seenAgain, got ${r1.seenAgain}`);
        else pass("first run: 0 seenAgain");
        if (r1.closed !== 0) fail(`first run: expected 0 closed (skipped on first run), got ${r1.closed}`);
        else pass("first run: 0 closed (correctly skipped)");

        // Verify rows landed
        const allPostings = await prisma.jobPosting.findMany({ where: { watchlistId } });
        if (allPostings.length !== 3) fail(`expected 3 posting rows, found ${allPostings.length}`);
        else pass("3 JobPosting rows in DB after first run");

        // Notifications: 3 individual (under the 20-row threshold for first-run digest)
        const notif1 = await prisma.notification.findMany({ where: { userId: user.id, createdAt: { gt: new Date(Date.now() - 60_000) } } });
        if (notif1.length !== 3) fail(`expected 3 notifications, found ${notif1.length}`);
        else pass("3 individual posting notifications fired (under digest threshold)");

        // ─── Second run: same fixture → all seenAgain, no new ───
        const r2 = await runWatchlist(watchlistId);
        if (r2.error) return fail("second run errored", r2.error);
        if (r2.newPostings !== 0) fail(`second run: expected 0 new, got ${r2.newPostings}`);
        else pass("second run: 0 new postings (dedup working)");
        if (r2.seenAgain !== 3) fail(`second run: expected 3 seenAgain, got ${r2.seenAgain}`);
        else pass("second run: 3 seenAgain");

        // ─── Third run: fixture loses one + gains one ───
        // To exercise closed-detection, backdate lastSeenAt of the "Designer"
        // posting by 7h so it falls outside the 6h grace window.
        const designer = allPostings.find(p => p.title === "Designer");
        if (!designer) return fail("designer posting missing");
        const sevenHoursAgo = new Date(Date.now() - 7 * 60 * 60 * 1000);
        await prisma.jobPosting.update({
            where: { id: designer.id },
            data: { lastSeenAt: sevenHoursAgo },
        });

        // Update fixture: drop Designer, add Manager
        fixture.setPostings([
            { slug: "100", title: "Senior Engineer" },
            { slug: "300", title: "Product Manager" },
            { slug: "400", title: "Engineering Manager" }, // new
        ]);

        const r3 = await runWatchlist(watchlistId);
        if (r3.error) return fail("third run errored", r3.error);
        if (r3.newPostings !== 1) fail(`third run: expected 1 new (Engineering Manager), got ${r3.newPostings}`);
        else pass("third run: 1 new posting");
        if (r3.seenAgain !== 2) fail(`third run: expected 2 seenAgain, got ${r3.seenAgain}`);
        else pass("third run: 2 seenAgain");
        // OQ5a two-tick close confirmation: the first closed probe verdict
        // (fixture 404s the Designer URL) stamps pendingClosedAt only — no
        // status flip, no closed-count.
        if (r3.closed !== 0) fail(`third run: expected 0 closed (first strike is pending-only, OQ5a), got ${r3.closed}`);
        else pass("third run: 0 closed — first closed verdict stamps pending only (OQ5a)");

        const designerPending = await prisma.jobPosting.findUnique({ where: { id: designer.id } });
        if (designerPending?.status !== "new") fail(`Designer should still be status=new after first strike, got ${designerPending?.status}`);
        else pass("Designer still status=new after first closed verdict");
        if (!designerPending?.pendingClosedAt) fail("Designer pendingClosedAt not stamped on first closed verdict");
        else pass("Designer pendingClosedAt stamped on first closed verdict");
        if (designerPending?.removedAt) fail("Designer removedAt must not be set on first strike");
        else pass("Designer removedAt still null after first strike");

        // ─── Fourth run: second consecutive closed verdict → confirmed close ───
        const r4 = await runWatchlist(watchlistId);
        if (r4.error) return fail("fourth run errored", r4.error);
        if (r4.newPostings !== 0) fail(`fourth run: expected 0 new, got ${r4.newPostings}`);
        else pass("fourth run: 0 new (steady state)");
        if (r4.closed !== 1) fail(`fourth run: expected 1 closed (Designer confirmed, OQ5a), got ${r4.closed}`);
        else pass("fourth run: 1 closed — second consecutive verdict confirms (OQ5a)");

        // Verify the Designer posting is now closed
        const designerAfter = await prisma.jobPosting.findUnique({ where: { id: designer.id } });
        if (designerAfter?.status !== "closed") fail(`Designer should be closed, status=${designerAfter?.status}`);
        else pass("Designer posting now status=closed");
        if (!designerAfter?.removedAt) fail("Designer removedAt not set");
        else pass("Designer removedAt set");
        if (designerAfter?.pendingClosedAt) fail("Designer pendingClosedAt should be cleared on the confirmed flip");
        else pass("Designer pendingClosedAt cleared on the confirmed flip");

        // ─── Fifth run: same fixture, no new actions ───
        const r4b = await runWatchlist(watchlistId);
        if (r4b.error) return fail("steady-state run errored", r4b.error);
        if (r4b.newPostings !== 0) fail(`steady-state run: expected 0 new, got ${r4b.newPostings}`);
        else pass("steady-state run: 0 new");
        if (r4b.closed !== 0) fail(`steady-state run: expected 0 closed (already closed), got ${r4b.closed}`);
        else pass("steady-state run: already-closed posting not re-closed");

        // ─── Empty-fetch safety: fixture returns 0 postings → must NOT mass-close ───
        // This is the bug from the code review: when seenExternalIds is empty,
        // `notIn: []` matches every prior row. The fix skips closed-detection
        // on empty fetches. Backdate every remaining open posting past the 6h
        // grace so the only thing preventing mass-close is the new guard.
        const remaining = await prisma.jobPosting.findMany({
            where: { watchlistId, status: { notIn: ["closed", "hidden"] } },
            select: { id: true },
        });
        const longAgo = new Date(Date.now() - 7 * 60 * 60 * 1000);
        await prisma.jobPosting.updateMany({
            where: { id: { in: remaining.map(r => r.id) } },
            data: { lastSeenAt: longAgo },
        });
        fixture.setPostings([]); // empty fixture — simulates transient source blank
        const rEmpty = await runWatchlist(watchlistId);
        if (rEmpty.error) return fail("empty-fetch run errored", rEmpty.error);
        if (rEmpty.closed !== 0) fail(`empty-fetch safety: expected 0 closed, got ${rEmpty.closed} — bug regressed!`);
        else pass("empty-fetch safety: 0 closed despite stale lastSeenAt (bug stays fixed)");
        const openAfter = await prisma.jobPosting.count({ where: { watchlistId, status: { notIn: ["closed", "hidden"] } } });
        if (openAfter !== remaining.length) fail(`empty-fetch safety: ${remaining.length - openAfter} postings flipped despite empty fetch`);
        else pass("empty-fetch safety: open postings count unchanged");

        // ─── Fifth: server returns 500, watchlist records error ───
        // Need to capture the next request to return 500. Approach: stop the
        // server, run, then restart. Actually simpler: change linkPattern via
        // direct DB update to invalid regex.
        await prisma.watchlist.update({
            where: { id: watchlistId },
            data: {
                config: JSON.stringify({
                    kind: "careers-page",
                    rootUrl: fixture.rootUrl(),
                    linkPattern: "[", // invalid regex
                    companyName: "Hermetic Co",
                }),
            },
        });
        const r5 = await runWatchlist(watchlistId);
        if (!r5.error) fail("fifth run: expected error from invalid regex");
        else pass("fifth run: invalid regex → error");
        const wAfter = await prisma.watchlist.findUnique({ where: { id: watchlistId } });
        if (!wAfter?.lastError) fail("fifth run: lastError not recorded on watchlist");
        else pass("fifth run: lastError recorded on watchlist row");

        // ─── Concurrent runs: per-watchlist mutex (#4) ───
        // Fire two runWatchlist calls in parallel. The mutex should share the
        // in-flight promise so both callers get the same result and no
        // duplicate-create P2002 hits the DB. First restore a valid config
        // (the prior test corrupted linkPattern); then point the fixture at a
        // brand-new posting so two parallel runs would otherwise race to create.
        await prisma.watchlist.update({
            where: { id: watchlistId },
            data: {
                config: JSON.stringify({
                    kind: "careers-page",
                    rootUrl: fixture.rootUrl(),
                    linkPattern: "/careers/jobs/",
                    companyName: "Hermetic Co",
                }),
                lastError: null,
            },
        });
        fixture.setPostings([
            { slug: "100", title: "Senior Engineer" },
            { slug: "300", title: "Product Manager" },
            { slug: "400", title: "Engineering Manager" },
            { slug: "500", title: "Newly Posted" }, // unseen — both runs would race to create
        ]);
        const [pA, pB] = [runWatchlist(watchlistId), runWatchlist(watchlistId)];
        const [resA, resB] = await Promise.all([pA, pB]);
        if (resA.error || resB.error) fail(`concurrent runs errored: A=${resA.error}, B=${resB.error}`);
        else pass("two parallel runWatchlist calls both succeeded");
        if (resA.newPostings !== resB.newPostings || resA.seenAgain !== resB.seenAgain) {
            fail(`concurrent runs returned different counts: A=${JSON.stringify(resA)} B=${JSON.stringify(resB)}`);
        } else {
            pass("concurrent runs returned identical RunResult (mutex shared the in-flight promise)");
        }
        // The total newly-created row count for slug 500 should be exactly 1, not 2.
        const newlyPostedCount = await prisma.jobPosting.count({
            where: { watchlistId, title: "Newly Posted" },
        });
        if (newlyPostedCount !== 1) fail(`concurrent runs created ${newlyPostedCount} rows for "Newly Posted", expected 1`);
        else pass("concurrent runs created exactly 1 JobPosting row for the new posting");

        // ─── Paused watchlist: skip ───
        await prisma.watchlist.update({
            where: { id: watchlistId },
            data: { active: false },
        });
        const r6 = await runWatchlist(watchlistId);
        if (!r6.error?.includes("paused")) fail(`paused watchlist: expected paused error, got ${r6.error}`);
        else pass("paused watchlist: rejected with 'paused' error");
    } finally {
        if (watchlistId) {
            await prisma.notification.deleteMany({ where: { userId: user.id, createdAt: { gt: new Date(Date.now() - 5 * 60_000) } } }).catch(() => undefined);
            await prisma.watchlist.delete({ where: { id: watchlistId } }).catch(() => undefined);
        }
        if (globalFilterSnapshot !== null && globalFilterSnapshot !== "[]") {
            await prisma.globalSetting.update({
                where: { id: "global" },
                data: { globalNegativeFilters: globalFilterSnapshot },
            }).catch(() => undefined);
        }
        await prisma.$disconnect();
        await fixture.stop();
        console.log(`\n${passes}/${passes + fails} steps passed`);
        if (fails === 0) console.log("All checks passed.");
    }
    if (fails > 0) process.exit(1);
}

main().catch(e => {
    console.error("Unhandled error:", e);
    process.exit(2);
});
