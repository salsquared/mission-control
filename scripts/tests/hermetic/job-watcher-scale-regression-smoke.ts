/**
 * Hermetic regression for Bug C (commit 4f1854d) — close-detection used to
 * shape its query as `externalId: { notIn: Array.from(seenExternalIds) }`.
 * Prisma's effective parameter cap for a SQLite `notIn (…)` is 999, and
 * `notIn` is a negation filter Prisma refuses to auto-split (P2029, would
 * change semantics). Big watchlists — SpaceX (1688 active), Boeing (1462),
 * Blue Origin (1040) — silently P2029'd every crawl, so postings removed
 * from those sources stayed "active" forever.
 *
 * Fix: SELECT stale candidates without notIn, diff against seenExternalIds
 * in JS, UPDATE by `id: { in: [...] }` (in IS splittable). This test seeds
 * 1100 JobPosting rows + a fixture returning a tiny subset, runs the
 * watchlist, and verifies (a) no P2029 thrown and (b) the right rows got
 * marked closed.
 *
 * OQ5a (P3.2): a closed verdict now needs TWO consecutive ticks to flip
 * (tick 1 stamps pendingClosedAt; tick 2 confirms), so the watchlist runs
 * TWICE. Both bulk UPDATEs — the tick-1 pendingClosedAt stamp and the
 * tick-2 close flip — handle the same >999-id load, so the P2029
 * regression coverage holds on both paths.
 *
 *   DATABASE_URL="file:./dev.db" npx tsx scripts/tests/hermetic/job-watcher-scale-regression-smoke.ts
 */
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { AddressInfo } from "net";
import { PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";

process.env.MC_ALLOW_PRIVATE_FETCH = "1";
// Probe gate (docs/archive/close-detection-probe.md) would otherwise cap the close
// path at the per-kind maxPerTick (50 for careers-page) — but this test
// exists specifically to verify the close UPDATE handles >999 ids without
// Prisma P2029, which requires actually attempting to close all 1100 rows
// in one tick. Bypass routes every probe straight to "closed" and skips
// the cap. Production never sets this env.
process.env.MC_LIVENESS_BYPASS = "closed";

import { runWatchlist } from "@/scheduler/jobs/job-watcher";

const prisma = new PrismaClient();

let passes = 0;
let fails = 0;
function pass(msg: string) { console.log(`[PASS] ${msg}`); passes++; }
function fail(msg: string, detail?: unknown) { console.error(`[FAIL] ${msg}`, detail ?? ""); fails++; }

function externalIdFor(company: string, title: string, sourceUrl: string): string {
    return createHash("sha256").update(`${company}|${title}|${sourceUrl}`).digest("hex");
}

const COMPANY = "Scale-Regression Co";

// Above Prisma's 999-parameter cap. 1100 is enough to exercise the bug path
// without slowing the test much. The pre-fix code would throw P2029; the
// fixed code paginates internally via the 2-step (SELECT then UPDATE-by-id).
const ROW_COUNT = 1_100;

class FixtureServer {
    private postings: { slug: string; title: string }[] = [];
    private server: ReturnType<typeof createServer>;
    public port = 0;
    constructor() {
        this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
            if (req.url === "/careers/") {
                const links = this.postings
                    .map(p => `<a href="/careers/jobs/${p.slug}">${p.title}</a>`)
                    .join("\n");
                res.writeHead(200, { "content-type": "text/html" });
                res.end(`<!doctype html><html><body>${links}</body></html>`);
            } else {
                res.writeHead(404).end();
            }
        });
    }
    async start(): Promise<void> {
        await new Promise<void>(r => this.server.listen(0, "127.0.0.1", () => r()));
        this.port = (this.server.address() as AddressInfo).port;
    }
    setPostings(p: { slug: string; title: string }[]) { this.postings = p; }
    rootUrl(): string { return `http://127.0.0.1:${this.port}/careers/`; }
    async stop(): Promise<void> {
        await new Promise<void>(r => this.server.close(() => r()));
    }
}

async function main() {
    const fixture = new FixtureServer();
    await fixture.start();

    const user = await prisma.user.findFirst();
    if (!user) {
        console.error("No user in dev.db — log in first.");
        process.exit(1);
    }

    // Clear global filters so test postings aren't suppressed.
    const globalRow = await prisma.globalSetting.findUnique({ where: { id: "global" } });
    const filterSnapshot = globalRow?.globalNegativeFilters ?? null;
    if (globalRow && filterSnapshot !== "[]") {
        await prisma.globalSetting.update({
            where: { id: "global" },
            data: { globalNegativeFilters: "[]" },
        });
    }

    let watchlistId = "";
    try {
        // Single fixture posting — this represents the only posting still
        // live on the source. Title chosen so the heuristic returns
        // "internship" → no LLM call needed in the create-branch path.
        const SURVIVOR = { slug: "live-1", title: "Software Engineer Intern" };
        fixture.setPostings([SURVIVOR]);

        const wlConfig = JSON.stringify({
            kind: "careers-page",
            rootUrl: fixture.rootUrl(),
            linkPattern: "/careers/jobs/",
            companyName: COMPANY,
        });
        const wl = await prisma.watchlist.create({
            data: {
                userId: user.id,
                name: "Scale Regression",
                kind: "careers-page",
                config: wlConfig,
                scheduleMinutes: 60,
                // Mark already-crawled so close-detection runs (isFirstRun gate).
                lastRunAt: new Date(Date.now() - 60 * 60 * 1000),
                lastSuccessAt: new Date(Date.now() - 60 * 60 * 1000),
            },
        });
        watchlistId = wl.id;

        // Seed ROW_COUNT stale "ghost" rows — all backdated past the 6h grace
        // so close-detection would mark them closed if nothing prevented it.
        // Pre-fix: 1100 > 999 in notIn → P2029 → close-detection throws.
        // Post-fix: 2-step query works fine.
        const sevenHoursAgo = new Date(Date.now() - 7 * 60 * 60 * 1000);
        const batchSize = 100;
        for (let start = 0; start < ROW_COUNT; start += batchSize) {
            const rows = [];
            for (let i = start; i < Math.min(start + batchSize, ROW_COUNT); i++) {
                const t = `Ghost Posting ${i}`;
                const u = `${fixture.rootUrl()}jobs/ghost-${i}`;
                rows.push({
                    watchlistId,
                    externalId: externalIdFor(COMPANY, t, u),
                    company: COMPANY,
                    title: t,
                    sourceUrl: u,
                    employmentType: null,
                    status: "new",
                    firstSeenAt: sevenHoursAgo,
                    lastSeenAt: sevenHoursAgo,
                    raw: "{}",
                });
            }
            await prisma.jobPosting.createMany({ data: rows });
        }
        pass(`seeded ${ROW_COUNT} stale rows for watchlist ${watchlistId.slice(0, 8)}`);

        // Tick 1. Pre-fix this would throw / log P2029 inside close-detection's
        // updateMany. Post-fix (and post-OQ5a) it succeeds and stamps
        // pendingClosedAt on all ROW_COUNT stale rows (everything not in
        // seenExternalIds, which is just the 1 SURVIVOR slug) — the >999-id
        // bulk UPDATE now happens on the pending path first.
        const r = await runWatchlist(watchlistId);
        if (r.error) {
            fail(`scale-run tick 1 errored — likely the P2029 regressed: ${r.error}`);
        } else {
            pass("scale-run tick 1 completed without throwing P2029");
        }

        //   - 1 SURVIVOR seenAgain? No — it's NEW (no prior row), so newPostings=1.
        if (r.newPostings !== 1) {
            fail(`expected newPostings=1 (SURVIVOR), got ${r.newPostings}`);
        } else {
            pass("scale-run tick 1: 1 new posting created from fixture");
        }
        // OQ5a: first closed verdict must NOT flip anything — pending only.
        if (r.closed !== 0) {
            fail(`OQ5a tick 1: expected closed=0 (first strike stamps pending only), got ${r.closed}`);
        } else {
            pass("OQ5a tick 1: closed=0 — no one-tick flip");
        }
        const pendingAfterTick1 = await prisma.jobPosting.count({
            where: { watchlistId, status: "new", pendingClosedAt: { not: null } },
        });
        if (pendingAfterTick1 !== ROW_COUNT) {
            fail(`OQ5a tick 1: expected ${ROW_COUNT} rows with pendingClosedAt set, got ${pendingAfterTick1} — the >999-id pending UPDATE may have P2029'd`);
        } else {
            pass(`OQ5a tick 1: all ${ROW_COUNT} ghost rows stamped pendingClosedAt (still status='new')`);
        }

        // Tick 2 — second consecutive closed verdict confirms the close. This
        // is the >999-id close UPDATE the original regression guarded.
        const r2 = await runWatchlist(watchlistId);
        if (r2.error) {
            fail(`scale-run tick 2 errored — likely the P2029 regressed: ${r2.error}`);
        } else {
            pass("scale-run tick 2 completed without throwing P2029");
        }
        if (r2.closed !== ROW_COUNT) {
            fail(`OQ5a tick 2: expected closed=${ROW_COUNT}, got ${r2.closed}`);
        } else {
            pass(`OQ5a tick 2: ${ROW_COUNT} stale rows correctly marked closed on confirmation`);
        }

        // Spot-check the rows ended up in status="closed".
        const closedSample = await prisma.jobPosting.count({
            where: { watchlistId, status: "closed" },
        });
        if (closedSample !== ROW_COUNT) {
            fail(`DB check: expected ${ROW_COUNT} closed rows, found ${closedSample}`);
        } else {
            pass(`DB check: all ${ROW_COUNT} ghost rows are status='closed'`);
        }
    } finally {
        // Sweep BOTH (a) the SURVIVOR's per-posting dispatch AND (b) the
        // closure-summary notification fired by job-watcher when it closes
        // ≥1 postings (kind="system", dedupKey=`watchlist-closures:${wlId}:${date}`).
        // Without the second filter watchlist-hermetic-smoke later sees the
        // leftover via its 60s `findMany({ userId, createdAt > -60s })` window.
        if (watchlistId) {
            await prisma.notification.deleteMany({
                where: {
                    userId: user.id,
                    createdAt: { gt: new Date(Date.now() - 5 * 60 * 1000) },
                    OR: [
                        { kind: "posting" },
                        { dedupKey: { startsWith: `watchlist-closures:${watchlistId}:` } },
                    ],
                },
            }).catch(() => undefined);
            await prisma.jobPosting.deleteMany({ where: { watchlistId } }).catch(() => undefined);
            await prisma.watchlist.delete({ where: { id: watchlistId } }).catch(() => undefined);
        }
        if (filterSnapshot !== null && filterSnapshot !== "[]") {
            await prisma.globalSetting.update({
                where: { id: "global" },
                data: { globalNegativeFilters: filterSnapshot },
            }).catch(() => undefined);
        }
        await prisma.$disconnect();
        await fixture.stop();
        console.log(`\n${passes}/${passes + fails} steps passed`);
        if (fails === 0) console.log("All checks passed.");
    }
    if (fails > 0) process.exit(1);
}

main().catch((e) => {
    console.error("Unhandled error:", e);
    process.exit(1);
});
