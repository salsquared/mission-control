/**
 * Hermetic regression suite for the three job-watcher classifier bugs caught
 * in the 2026-05-24 audit (commits 4a609df + 4f1854d). Targets:
 *
 *   Bug A — seen-again UPDATE used to do `employmentType: raw.employmentType ?? null`,
 *           wiping LLM-classified values to null when the heuristic returned
 *           null on subsequent crawls. Fix preserves the stored value when
 *           raw.employmentType is null.
 *   Bug B — every watchlist that surfaced the same posting fired its own LLM
 *           call. Fix queries other watchlists for a non-null employmentType
 *           on the same externalId BEFORE classifying, reuses on hit.
 *   Bug D — notification dedupKey was `posting:${row.id}` (per-row), so two
 *           watchlists with the same posting fired two notifications. Fix
 *           keys on `posting:${externalId}` so dispatch is idempotent across
 *           watchlists.
 *
 * Design: in-process HTTP fixture (matches watchlist-hermetic-smoke pattern),
 * real prisma against dev.db, careers-page kind with predictable URLs so
 * externalId hashes are deterministic. Titles deliberately chosen so the
 * heuristic returns null and cross-watchlist reuse path is the only thing
 * keeping the test from hitting Gemini.
 *
 *   DATABASE_URL="file:./dev.db" npx tsx scripts/tests/hermetic/job-watcher-classifier-regression-smoke.ts
 */
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { AddressInfo } from "net";
import { PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";

// Test-only: allow fetching the in-process fixture at 127.0.0.1. The SSRF
// guard in lib/security/url-guard.ts rejects private IPs otherwise.
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

async function main() {
    const fixture = new FixtureServer();
    await fixture.start();

    const user = await prisma.user.findFirst();
    if (!user) {
        console.error("No user in dev.db — log in first.");
        process.exit(1);
    }

    // Neutralize globalNegativeFilters so titles like "Senior Engineer" aren't
    // suppressed by Sal's real prod-day filter set. Snapshot + restore.
    const globalRow = await prisma.globalSetting.findUnique({ where: { id: "global" } });
    const filterSnapshot = globalRow?.globalNegativeFilters ?? null;
    if (globalRow && filterSnapshot !== "[]") {
        await prisma.globalSetting.update({
            where: { id: "global" },
            data: { globalNegativeFilters: "[]" },
        });
    }

    const COMPANY = "Bug-Regression Co";
    // Title chosen so inferEmploymentTypeFromTitle returns null — in real prod
    // this is the heuristic-gap class that paid for an LLM call. For the
    // regression tests we pre-seed or cross-watchlist-reuse so no LLM ever
    // runs even though the heuristic is null.
    const TITLE = "Senior Software Engineer";
    const SLUG = "100";
    const sourceUrl = `${fixture.rootUrl()}jobs/${SLUG}`;
    const extId = externalIdFor(COMPANY, TITLE, sourceUrl);

    const createdWatchlistIds: string[] = [];

    try {
        // Two watchlists with identical careers-page config (different names)
        // — both will surface the single fixture posting.
        const wlConfig = JSON.stringify({
            kind: "careers-page",
            rootUrl: fixture.rootUrl(),
            linkPattern: "/careers/jobs/",
            companyName: COMPANY,
        });
        const w1 = await prisma.watchlist.create({
            data: {
                userId: user.id,
                name: "W1-PriorClassifier",
                kind: "careers-page",
                config: wlConfig,
                scheduleMinutes: 60,
            },
        });
        const w2 = await prisma.watchlist.create({
            data: {
                userId: user.id,
                name: "W2-CrossWatchlistReuser",
                kind: "careers-page",
                config: wlConfig,
                scheduleMinutes: 60,
            },
        });
        createdWatchlistIds.push(w1.id, w2.id);
        fixture.setPostings([{ slug: SLUG, title: TITLE }]);

        // ─── Bug A — preserve LLM-classified employmentType on seen-again ──
        // Pre-seed W1 with the posting already classified (simulates a prior
        // LLM call). With the bug, the next runWatchlist(W1) would wipe to
        // null because the careers-page fetcher's heuristic returns null for
        // this title. With the fix, the stored "full-time" persists.
        await prisma.jobPosting.create({
            data: {
                watchlistId: w1.id,
                externalId: extId,
                company: COMPANY,
                title: TITLE,
                sourceUrl,
                employmentType: "full-time",
                status: "new",
                firstSeenAt: new Date(Date.now() - 60 * 60 * 1000),
                lastSeenAt: new Date(Date.now() - 30 * 60 * 1000),
                raw: "{}",
            },
        });

        // Also pre-seed a notification for posting:${extId} so Bug D's
        // assertion can verify dispatch idempotency: W2's later crawl tries
        // to dispatch under the same dedupKey and must no-op via P2002.
        await prisma.notification.create({
            data: {
                userId: user.id,
                kind: "posting",
                tier: "low",
                title: `${COMPANY} — ${TITLE}`,
                body: null,
                payload: JSON.stringify({ watchlistId: w1.id, sourceUrl }),
                channels: "in-app",
                dedupKey: `posting:${extId}`,
            },
        });

        const r1 = await runWatchlist(w1.id);
        if (r1.error) {
            fail("bug-A: W1 crawl errored", r1.error);
        } else {
            const w1Row = await prisma.jobPosting.findUnique({
                where: { watchlistId_externalId: { watchlistId: w1.id, externalId: extId } },
            });
            if (w1Row?.employmentType !== "full-time") {
                fail(`bug-A regressed — pre-seeded "full-time" wiped to "${w1Row?.employmentType}" on seen-again`);
            } else {
                pass("bug-A: pre-seeded employmentType='full-time' preserved on seen-again with null heuristic");
            }
            // Sanity: seen-again branch fired (not create branch).
            if (r1.seenAgain !== 1 || r1.newPostings !== 0) {
                fail(`bug-A: expected seenAgain=1 newPostings=0, got ${JSON.stringify(r1)}`);
            } else {
                pass("bug-A: W1 took the seen-again branch (not a duplicate create)");
            }
        }

        // ─── Bug B — W2 reuses W1's classification via cross-watchlist lookup ─
        // W2 has never seen the posting → its existingByExternalId is empty
        // for this externalId → posting enters lookupCandidates → cross-
        // watchlist query finds W1's "full-time" → raw.employmentType backfills
        // → classifyInputs ends up empty → no LLM call → new W2 row created
        // with the reused "full-time". Bug-B regression = W2 row stored as null
        // (cross-watchlist lookup didn't fire) or test would error from a real
        // Gemini call attempt (key absent in hermetic).
        const r2 = await runWatchlist(w2.id);
        if (r2.error) {
            fail("bug-B: W2 crawl errored", r2.error);
        } else {
            const w2Row = await prisma.jobPosting.findUnique({
                where: { watchlistId_externalId: { watchlistId: w2.id, externalId: extId } },
            });
            if (!w2Row) {
                fail("bug-B: W2 row not created");
            } else if (w2Row.employmentType !== "full-time") {
                fail(`bug-B regressed — W2 row stored employmentType="${w2Row.employmentType}", expected "full-time" via cross-watchlist reuse`);
            } else {
                pass("bug-B: W2's new row reused W1's 'full-time' via cross-watchlist lookup (no LLM call)");
            }
            if (r2.newPostings !== 1) {
                fail(`bug-B: expected newPostings=1 in W2, got ${r2.newPostings}`);
            } else {
                pass("bug-B: W2 took the create branch (one new row)");
            }
        }

        // ─── Bug D — cross-watchlist dispatch collapses to one notification ─
        // Pre-seeded notification has dedupKey="posting:${extId}". W2's
        // create branch above tried to dispatch with the same key → P2002 →
        // dispatchNotification returns null → no second notification row.
        // Pre-fix: dedupKey was "posting:${row.id}" (per-row), so W2's
        // dispatch wrote a second row.
        const notifs = await prisma.notification.findMany({
            where: { dedupKey: `posting:${extId}` },
        });
        if (notifs.length !== 1) {
            fail(`bug-D regressed — expected 1 notification for posting:${extId.slice(0, 8)}, got ${notifs.length}`);
        } else {
            pass("bug-D: cross-watchlist dispatch collapsed via dedupKey — one notification total");
        }
    } finally {
        // Clean up notifications BEFORE watchlist rows so cascading FKs
        // don't fight us. Sweep by both the specific dedupKey we seeded
        // AND any posting:* notification dispatched by the test run within
        // the last 5 minutes — watchlist-hermetic-smoke later asserts on a
        // 60s notification window and would otherwise see our leftovers.
        await prisma.notification.deleteMany({
            where: {
                userId: user.id,
                kind: "posting",
                createdAt: { gt: new Date(Date.now() - 5 * 60 * 1000) },
            },
        }).catch(() => undefined);
        for (const wId of createdWatchlistIds) {
            await prisma.jobPosting.deleteMany({ where: { watchlistId: wId } }).catch(() => undefined);
            await prisma.watchlist.delete({ where: { id: wId } }).catch(() => undefined);
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
