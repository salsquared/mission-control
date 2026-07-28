/**
 * Hermetic smoke for the P2.3 per-user config-bleed fixes
 * (docs/multi-user-crew.html §2.6 — "four findGlobalSetting() reads").
 *
 *   DATABASE_URL="file:./dev.db" npx tsx scripts/tests/hermetic/config-bleed-multi-user-smoke.ts
 *
 * `GlobalSetting.globalNegativeFilters` is per-user, but three consumers used
 * to read it through a zero-argument `findGlobalSetting()` that always resolved
 * the OWNER's row — so under multi-user the owner's blocklist governed everyone
 * else's postings. Two of those are data-loss bugs, and both are asserted here
 * with TWO users whose filters are disjoint (each user's pattern is harmless to
 * the other), so any cross-apply shows up as a missing or extra row:
 *
 *   Part 1 (P2.3.1 — job-watcher ingestion drop, highest severity)
 *     The global filter is an ingestion DROP: matching postings are removed
 *     BEFORE the existence query and the create, so a posting dropped under a
 *     foreign blocklist leaves no row anywhere to notice. Silent and permanent.
 *     Asserted in both directions: A's "Senior" pattern must not touch B's
 *     crawl, and B's "Warehouse" pattern must not touch A's.
 *
 *   Part 2 (P2.3.3 — posting-digest contents)
 *     Same corpus under each user's digest watchlist; each digest must contain
 *     exactly the postings that user's own filters spare.
 *
 *   Part 3 (P2.3.3 — posting-digest WATERMARK, the permanent half)
 *     runPostingDigest advances lastDigestAt even when every posting in the
 *     window was culled ("considered and rejected"), and the watermark only
 *     moves forward. So a posting culled by SOMEONE ELSE's config is not merely
 *     missing from one digest — it falls behind the watermark and is never
 *     digested at all. Part 3 gives user A a window containing only a posting
 *     that B's filter would cull, and asserts A's digest dispatches it instead
 *     of silently retiring it.
 *
 * Hermetic: no network beyond an in-process 127.0.0.1 careers-page fixture, no
 * PM2, no Gemini (both watchlists are created NON-first-run so the inline
 * classifier is skipped, and with no pre-existing rows there are no stale
 * liveness candidates to probe). Users, watchlists, postings, notifications and
 * settings rows are throwaway and deleted in `finally`; the real account's
 * settings row is never read or written.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { AddressInfo } from "net";
import { PrismaClient } from "@prisma/client";
import { createHash, randomBytes } from "node:crypto";

// Test-only: allow fetching the in-process fixture at 127.0.0.1. The SSRF guard
// in lib/security/url-guard.ts rejects private IPs otherwise. Must be set
// BEFORE importing job-watcher (which transitively pulls the guard).
process.env.MC_ALLOW_PRIVATE_FETCH = "1";
process.env.EMAIL_ENABLED = "0";

import { runWatchlist } from "@/scheduler/jobs/job-watcher";
import { runPostingDigest } from "@/scheduler/jobs/posting-digest";
import { _resetNegativeFilterCache } from "@/lib/postings/negative-filters";

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

const COMPANY = "ConfigBleed-Co";

// Disjoint blocklists: neither user's pattern matches the other's survivors, so
// a cross-apply is visible as a specific missing/extra title rather than a
// count wobble.
const A_FILTER = "Senior";
const B_FILTER = "Warehouse";

const SENIOR = { slug: "senior", title: "Senior Platform Engineer" }; // culled for A only
const WAREHOUSE = { slug: "wh", title: "Warehouse Associate" };       // culled for B only
const NEUTRAL = { slug: "neutral", title: "Software Engineer" };      // survives for both

async function main() {
    const fixture = new FixtureServer();
    await fixture.start();

    const tag = randomBytes(4).toString("hex");
    const userA = `cfgbleed-a-${tag}`;
    const userB = `cfgbleed-b-${tag}`;
    const watchlistIds: string[] = [];

    try {
        _resetNegativeFilterCache();
        await prisma.user.create({ data: { id: userA, email: `cfgbleed-a-${tag}@example.invalid` } });
        await prisma.user.create({ data: { id: userB, email: `cfgbleed-b-${tag}@example.invalid` } });
        await prisma.globalSetting.create({
            data: { userId: userA, globalNegativeFilters: JSON.stringify([A_FILTER]) },
        });
        await prisma.globalSetting.create({
            data: { userId: userB, globalNegativeFilters: JSON.stringify([B_FILTER]) },
        });

        const wlConfig = JSON.stringify({
            kind: "careers-page",
            rootUrl: fixture.rootUrl(),
            linkPattern: "/careers/jobs/",
            companyName: COMPANY,
        });
        const makeCrawlWatchlist = (userId: string, name: string) => prisma.watchlist.create({
            data: {
                userId,
                name,
                kind: "careers-page",
                config: wlConfig,
                scheduleMinutes: 60,
                // This part asserts the ingest DROP, not dispatch — silence it.
                notificationMode: "silent",
                // NON-first-run so the inline classifier never fires (no Gemini).
                lastSuccessAt: new Date(Date.now() - 60 * 60 * 1000),
            },
        });

        // ────────────────────────────────────────────────────────────────
        // Part 1 — P2.3.1: the ingestion drop is scoped to the watchlist owner
        // ────────────────────────────────────────────────────────────────
        const wA = await makeCrawlWatchlist(userA, `CfgBleed A ${tag}`);
        const wB = await makeCrawlWatchlist(userB, `CfgBleed B ${tag}`);
        watchlistIds.push(wA.id, wB.id);

        fixture.setPostings([SENIOR, WAREHOUSE, NEUTRAL]);
        const extId = (p: { slug: string; title: string }) =>
            externalIdFor(COMPANY, p.title, `${fixture.rootUrl()}jobs/${p.slug}`);

        const rA = await runWatchlist(wA.id);
        if (rA.error) fail(`part1: user A crawl errored: ${rA.error}`);
        const rB = await runWatchlist(wB.id);
        if (rB.error) fail(`part1: user B crawl errored: ${rB.error}`);

        const titlesFor = async (watchlistId: string): Promise<Set<string>> => {
            const rows = await prisma.jobPosting.findMany({
                where: { watchlistId },
                select: { title: true },
            });
            return new Set(rows.map(r => r.title));
        };
        const aTitles = await titlesFor(wA.id);
        const bTitles = await titlesFor(wB.id);

        // A's own filter applies to A.
        if (aTitles.has(SENIOR.title)) fail(`part1: A stored "${SENIOR.title}" despite A's own "${A_FILTER}" filter`);
        else pass(`part1: A's own "${A_FILTER}" filter dropped "${SENIOR.title}" at ingest`);
        // B's filter must NOT apply to A — this is the cross-apply assertion.
        if (!aTitles.has(WAREHOUSE.title)) {
            fail(`part1: CROSS-APPLY — "${WAREHOUSE.title}" is missing from A's postings; B's "${B_FILTER}" filter dropped it at ingest (no row survives to notice)`);
        } else pass(`part1: B's "${B_FILTER}" filter did NOT drop "${WAREHOUSE.title}" from A's crawl`);

        // Mirror image: B's filter applies to B, A's does not.
        if (bTitles.has(WAREHOUSE.title)) fail(`part1: B stored "${WAREHOUSE.title}" despite B's own "${B_FILTER}" filter`);
        else pass(`part1: B's own "${B_FILTER}" filter dropped "${WAREHOUSE.title}" at ingest`);
        if (!bTitles.has(SENIOR.title)) {
            fail(`part1: CROSS-APPLY — "${SENIOR.title}" is missing from B's postings; A's "${A_FILTER}" filter dropped it at ingest`);
        } else pass(`part1: A's "${A_FILTER}" filter did NOT drop "${SENIOR.title}" from B's crawl`);

        if (!aTitles.has(NEUTRAL.title) || !bTitles.has(NEUTRAL.title)) {
            fail(`part1: the unfiltered posting is missing (A=${[...aTitles].join("|")} B=${[...bTitles].join("|")})`);
        } else pass("part1: the posting neither user filters is stored for both");

        if (rA.newPostings !== 2) fail(`part1: A expected newPostings=2, got ${rA.newPostings}`);
        else pass("part1: A ingested exactly 2 of 3 postings");
        if (rB.newPostings !== 2) fail(`part1: B expected newPostings=2, got ${rB.newPostings}`);
        else pass("part1: B ingested exactly 2 of 3 postings");

        // Same posting, two owners, opposite verdicts — proves the drop is
        // decided per owner and not once per externalId.
        const sharedSenior = extId(SENIOR);
        const seniorRows = await prisma.jobPosting.findMany({
            where: { externalId: sharedSenior, watchlistId: { in: [wA.id, wB.id] } },
            select: { watchlistId: true },
        });
        if (seniorRows.length !== 1 || seniorRows[0].watchlistId !== wB.id) {
            fail(`part1: expected the shared "${SENIOR.title}" externalId to exist for B only, got ${seniorRows.length} row(s)`);
        } else pass("part1: one externalId, two owners, opposite drop verdicts");

        // ────────────────────────────────────────────────────────────────
        // Part 2 — P2.3.3: each digest carries only that user's survivors
        // ────────────────────────────────────────────────────────────────
        const makeDigestWatchlist = (userId: string, name: string) => prisma.watchlist.create({
            data: {
                userId, name,
                kind: "careers-page",
                config: wlConfig,
                notificationMode: "digest",
                scheduleMinutes: 60,
            },
        });
        const dA = await makeDigestWatchlist(userA, `CfgBleed Digest A ${tag}`);
        const dB = await makeDigestWatchlist(userB, `CfgBleed Digest B ${tag}`);
        watchlistIds.push(dA.id, dB.id);

        const seedPosting = (watchlistId: string, slug: string, title: string, firstSeenAt?: Date) =>
            prisma.jobPosting.create({
                data: {
                    watchlistId,
                    externalId: `cfgbleed-${tag}-${watchlistId}-${slug}`,
                    company: COMPANY,
                    title,
                    sourceUrl: `https://example.invalid/careers/jobs/${slug}`,
                    status: "new",
                    raw: JSON.stringify({}),
                    ...(firstSeenAt ? { firstSeenAt } : {}),
                },
            });

        // Identical corpus under both digest watchlists.
        for (const wid of [dA.id, dB.id]) {
            await seedPosting(wid, "senior", SENIOR.title);
            await seedPosting(wid, "wh", WAREHOUSE.title);
            await seedPosting(wid, "neutral", NEUTRAL.title);
        }

        await runPostingDigest();

        const digestFor = async (userId: string, watchlistId: string) => {
            const notifs = await prisma.notification.findMany({
                where: { userId, kind: "posting", payload: { contains: `"watchlistId":"${watchlistId}"` } },
                orderBy: { createdAt: "asc" },
            });
            return notifs;
        };
        const bodyTitles = (body: string | null): Set<string> => {
            const out = new Set<string>();
            for (const t of [SENIOR.title, WAREHOUSE.title, NEUTRAL.title]) {
                if (body?.includes(t)) out.add(t);
            }
            return out;
        };

        const aDigests = await digestFor(userA, dA.id);
        const bDigests = await digestFor(userB, dB.id);
        if (aDigests.length !== 1) fail(`part2: expected 1 digest for A, got ${aDigests.length}`);
        else pass("part2: A got exactly 1 digest");
        if (bDigests.length !== 1) fail(`part2: expected 1 digest for B, got ${bDigests.length}`);
        else pass("part2: B got exactly 1 digest");

        if (aDigests[0]) {
            const inA = bodyTitles(aDigests[0].body);
            if (inA.has(SENIOR.title)) fail(`part2: A's digest previews "${SENIOR.title}" despite A's own "${A_FILTER}" filter`);
            else pass(`part2: A's digest excludes A's own filtered title`);
            if (!inA.has(WAREHOUSE.title)) {
                fail(`part2: CROSS-APPLY — A's digest is missing "${WAREHOUSE.title}"; B's "${B_FILTER}" filter culled it from A's digest`);
            } else pass(`part2: B's "${B_FILTER}" filter did NOT cull "${WAREHOUSE.title}" from A's digest`);
            const countA = JSON.parse(aDigests[0].payload).count;
            if (countA !== 2) fail(`part2: A's digest count=${countA}, expected 2 (all but A's own filtered title)`);
            else pass("part2: A's digest count = 2");
        }
        if (bDigests[0]) {
            const inB = bodyTitles(bDigests[0].body);
            if (inB.has(WAREHOUSE.title)) fail(`part2: B's digest previews "${WAREHOUSE.title}" despite B's own "${B_FILTER}" filter`);
            else pass(`part2: B's digest excludes B's own filtered title`);
            if (!inB.has(SENIOR.title)) {
                fail(`part2: CROSS-APPLY — B's digest is missing "${SENIOR.title}"; A's "${A_FILTER}" filter culled it from B's digest`);
            } else pass(`part2: A's "${A_FILTER}" filter did NOT cull "${SENIOR.title}" from B's digest`);
            const countB = JSON.parse(bDigests[0].payload).count;
            if (countB !== 2) fail(`part2: B's digest count=${countB}, expected 2 (all but B's own filtered title)`);
            else pass("part2: B's digest count = 2");
        }

        // ────────────────────────────────────────────────────────────────
        // Part 3 — P2.3.3: a foreign filter must not advance the watermark
        // ────────────────────────────────────────────────────────────────
        // A's window now contains ONE posting, matching B's filter only. Under
        // the bug the digest saw an all-culled window (`culledOnly`), skipped
        // dispatch AND advanced lastDigestAt past it — the posting is then
        // outside every future window, so it is never digested at all.
        const wlA = await prisma.watchlist.findUnique({ where: { id: dA.id }, select: { lastDigestAt: true } });
        const watermarkBefore = wlA?.lastDigestAt ?? null;
        if (!watermarkBefore) {
            fail("part3: A's watchlist has no lastDigestAt after part 2 — cannot position the window");
        } else {
            const lonely = await seedPosting(
                dA.id, "wh-only", `${WAREHOUSE.title} II`, new Date(watermarkBefore.getTime() + 10),
            );

            await runPostingDigest();

            const aDigestsAfter = await digestFor(userA, dA.id);
            const newDigest = aDigestsAfter.find(n => n.id !== aDigests[0]?.id);
            if (!newDigest) {
                fail(`part3: PERMANENT LOSS — "${WAREHOUSE.title} II" produced no digest for A; B's "${B_FILTER}" filter culled it, and the culledOnly branch retired it behind the watermark`);
            } else {
                pass(`part3: the posting only B's filter matches WAS digested for A (not swallowed by the culledOnly watermark advance)`);
                const ids = JSON.parse(newDigest.payload).postingIds;
                if (!Array.isArray(ids) || !ids.includes(lonely.id)) {
                    fail(`part3: A's new digest doesn't carry the posting id: ${JSON.stringify(ids)}`);
                } else pass("part3: A's new digest carries exactly the posting a foreign filter would have culled");
            }

            const wlAAfter = await prisma.watchlist.findUnique({ where: { id: dA.id }, select: { lastDigestAt: true } });
            const watermarkAfter = wlAAfter?.lastDigestAt ?? null;
            if (!newDigest && watermarkAfter && watermarkAfter.getTime() > watermarkBefore.getTime()) {
                fail("part3: lastDigestAt advanced past an un-dispatched posting — it can never be digested now");
            } else if (newDigest) {
                pass("part3: the watermark advanced on a real dispatch, not on a foreign cull");
            }
        }
    } finally {
        for (const wId of watchlistIds) {
            await prisma.jobPosting.deleteMany({ where: { watchlistId: wId } }).catch(() => undefined);
            await prisma.watchlist.delete({ where: { id: wId } }).catch(() => undefined);
        }
        for (const uid of [userA, userB]) {
            await prisma.notification.deleteMany({ where: { userId: uid } }).catch(() => undefined);
            // Deleting the user cascades its GlobalSetting row.
            await prisma.user.delete({ where: { id: uid } }).catch(() => undefined);
        }
        _resetNegativeFilterCache();
        await fixture.stop().catch(() => undefined);
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
