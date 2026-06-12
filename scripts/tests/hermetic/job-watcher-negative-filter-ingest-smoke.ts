/**
 * Hermetic smoke for the GLOBAL negative-filter ingestion DROP (2026-05-29).
 *
 * job-watcher drops postings matching the global negative filter immediately
 * after fetch — before the existence query, cross-watchlist lookup, LLM
 * classification, or row create. A blacklisted title therefore never enters the
 * system (no JobPosting row, no Gemini call). Compute saving on the Mac mini.
 *
 * Design (matches job-watcher-classifier-regression-smoke): in-process HTTP
 * careers-page fixture, real prisma against dev.db. The watchlist is created
 * NON-first-run with no pre-existing rows, so processOneInner takes neither the
 * inline-classify path (gated to first run) nor the liveness-probe path (no
 * stale candidates) — keeping the test fully hermetic (no real Gemini, no probe
 * network beyond the local fixture).
 *
 *   DATABASE_URL="file:./dev.db" npx tsx scripts/tests/hermetic/job-watcher-negative-filter-ingest-smoke.ts
 */
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { AddressInfo } from "net";
import { PrismaClient } from "@prisma/client";
import { createHash, randomBytes } from "node:crypto";

// Test-only: allow fetching the in-process fixture at 127.0.0.1. The SSRF guard
// in lib/security/url-guard.ts rejects private IPs otherwise. Must be set
// BEFORE importing job-watcher (which transitively pulls the guard).
process.env.MC_ALLOW_PRIVATE_FETCH = "1";

import { runWatchlist } from "@/scheduler/jobs/job-watcher";

const prisma = new PrismaClient();

let passes = 0;
let fails = 0;
function pass(msg: string) { console.log(`[PASS] ${msg}`); passes++; }
function fail(msg: string, detail?: unknown) { console.error(`[FAIL] ${msg}`, detail ?? ""); fails++; }

function externalIdFor(company: string, title: string, sourceUrl: string): string {
    return createHash("sha256").update(`${company}|${title}|${sourceUrl}`).digest("hex");
}

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

const COMPANY = "NegFilter-Ingest-Co";

async function main() {
    const fixture = new FixtureServer();
    await fixture.start();

    // Synthetic throwaway user — never attach test data (or a stray per-posting
    // notification) to the REAL dev.db user. Earlier this used
    // prisma.user.findFirst() and left the survivor's notification uncleaned, so
    // every push dripped a "NegFilter-Ingest-Co — Operations Coordinator" row
    // into the real notification feed. Cleaned up in `finally` below.
    const tag = randomBytes(4).toString("hex");
    const userId = `negfilt-ingest-smoke-user-${tag}`;
    await prisma.user.create({
        data: { id: userId, email: `negfilt-ingest-smoke-${tag}@example.invalid` },
    });

    // Snapshot + override the global filter to a known value (block "Senior").
    const origGlobalRow = await prisma.globalSetting.findUnique({
        where: { id: "global" },
        select: { globalNegativeFilters: true },
    });

    const createdWatchlistIds: string[] = [];
    try {
        await prisma.globalSetting.upsert({
            where: { id: "global" },
            update: { globalNegativeFilters: JSON.stringify(["Senior"]) },
            // userId required since the P2 scoping (one settings row per user);
            // the throwaway smoke user owns the bootstrap row on a fresh DB.
            create: { id: "global", userId, globalNegativeFilters: JSON.stringify(["Senior"]) },
        });

        const wlConfig = JSON.stringify({
            kind: "careers-page",
            rootUrl: fixture.rootUrl(),
            linkPattern: "/careers/jobs/",
            companyName: COMPANY,
        });
        // NON-first-run (lastSuccessAt set) so the inline classifier is skipped
        // (no real Gemini); no pre-existing rows so close-detection finds no
        // stale candidates (no probe).
        const wl = await prisma.watchlist.create({
            data: {
                userId,
                name: "NegFilter-Ingest-WL",
                kind: "careers-page",
                config: wlConfig,
                scheduleMinutes: 60,
                // This smoke asserts the ingest DROP, not notification dispatch —
                // silence it so the surviving posting never fires a notification.
                notificationMode: "silent",
                lastSuccessAt: new Date(Date.now() - 60 * 60 * 1000),
            },
        });
        createdWatchlistIds.push(wl.id);

        const BLOCKED = { slug: "1", title: "Senior Software Engineer" };
        const KEPT = { slug: "2", title: "Operations Coordinator" };
        fixture.setPostings([BLOCKED, KEPT]);

        const blockedExtId = externalIdFor(COMPANY, BLOCKED.title, `${fixture.rootUrl()}jobs/${BLOCKED.slug}`);
        const keptExtId = externalIdFor(COMPANY, KEPT.title, `${fixture.rootUrl()}jobs/${KEPT.slug}`);

        const result = await runWatchlist(wl.id);

        if (result.error) { fail(`runWatchlist errored: ${result.error}`); }

        const blockedRow = await prisma.jobPosting.findUnique({
            where: { watchlistId_externalId: { watchlistId: wl.id, externalId: blockedExtId } },
            select: { id: true },
        });
        const keptRow = await prisma.jobPosting.findUnique({
            where: { watchlistId_externalId: { watchlistId: wl.id, externalId: keptExtId } },
            select: { id: true },
        });

        if (blockedRow) fail("ingest-drop: 'Senior Software Engineer' was stored (should be dropped at ingest)");
        else pass("ingest-drop: global-filtered 'Senior' posting NOT stored — dropped before create");

        if (!keptRow) fail("ingest-drop: non-filtered 'Operations Coordinator' was NOT stored (drop too broad)");
        else pass("ingest-drop: non-filtered posting stored normally (drop is targeted)");

        if (result.newPostings !== 1) fail(`ingest-drop: expected newPostings=1 (only the kept one), got ${result.newPostings}`);
        else pass("ingest-drop: newPostings=1 — exactly the non-filtered posting counted");

        const total = await prisma.jobPosting.count({ where: { watchlistId: wl.id } });
        if (total !== 1) fail(`ingest-drop: expected 1 row total under the watchlist, got ${total}`);
        else pass("ingest-drop: exactly one row persisted under the watchlist");
    } finally {
        if (origGlobalRow) {
            await prisma.globalSetting.update({
                where: { id: "global" },
                data: { globalNegativeFilters: origGlobalRow.globalNegativeFilters },
            }).catch(() => undefined);
        }
        for (const wId of createdWatchlistIds) {
            await prisma.jobPosting.deleteMany({ where: { watchlistId: wId } }).catch(() => undefined);
            await prisma.watchlist.delete({ where: { id: wId } }).catch(() => undefined);
        }
        // Belt-and-suspenders: even with notificationMode="silent" + a synthetic
        // user, drop anything this run dispatched and the throwaway user itself.
        await prisma.notification.deleteMany({ where: { userId } }).catch(() => undefined);
        await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
        await fixture.stop();
        await prisma.$disconnect();
        console.log(`\n${passes}/${passes + fails} steps passed`);
        if (fails === 0) console.log("All checks passed.");
    }
    if (fails > 0) process.exit(1);
}

main().catch((e) => {
    console.error("Unhandled error:", e);
    process.exit(1);
});
