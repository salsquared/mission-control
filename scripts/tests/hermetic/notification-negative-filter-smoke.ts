/**
 * Hermetic smoke covering the negative-filter gate on notification dispatch.
 *
 *   DATABASE_URL="file:./dev.db" npx tsx scripts/tests/hermetic/notification-negative-filter-smoke.ts
 *
 * Original bug (May 2026): /api/postings GET applies BOTH GlobalSetting.global
 * NegativeFilters AND Watchlist.negativeFilters to cull rows at read time,
 * but scheduler/jobs/job-watcher.ts and scheduler/jobs/posting-digest.ts
 * dispatched notifications for every new posting regardless. So "Senior",
 * "Lead", etc. would show up in the notification bell even though the user
 * had filtered them out of the New Postings card.
 *
 * Follow-up (May 2026): the global filter was briefly split into per-track
 * career/side buckets, which let an "anduril" entry on the career list miss
 * an Anduril job surfaced by a side watchlist. The blocklist is now a single
 * shared list applied to every watchlist regardless of track — Part 5
 * regression-tests that.
 *
 * Covered here:
 *   1. Per-posting dispatch (notificationMode='each' via runWatchlist + a
 *      fixture HTTP server) honors the global filter, the per-watchlist
 *      filter, and the union of both.
 *   2. Digest dispatch (notificationMode='digest' via runPostingDigest) honors
 *      both filter sets, advances the watermark even when EVERY posting in
 *      the window is culled (so the digest doesn't re-evaluate the same
 *      culled cohort forever), and respects PB-3 "no advance on transient
 *      dispatch failure" by only advancing when we considered ≥1 posting.
 *   3. Global filters cull postings on side-tracked watchlists too (Part 5).
 *
 * UPDATE (2026-05-29): the GLOBAL filter is now an ingestion DROP — job-watcher
 * removes global-filtered postings before create, so they are NOT stored at all
 * (compute saving: no row, no LLM classify). The PER-WATCHLIST filter is
 * UNCHANGED — read-time only: the row is still stored, only its per-posting
 * notification is suppressed. Parts 1 & 5 (which run through job-watcher) assert
 * the global drop; Parts 2-4 insert rows directly via prisma.create (bypassing
 * job-watcher) so they still exercise the digest READ-time filter.
 *
 * Cleans up: deletes scratch watchlists, postings, notifications, and
 * RESTORES the prior GlobalSetting.globalNegativeFilters value so this smoke
 * doesn't bleed into posting-digest-smoke (which uses "Senior Engineer N"
 * titles and would break if globalNegativeFilters were left containing
 * "Senior").
 */
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { AddressInfo } from "net";
import { PrismaClient } from "@prisma/client";
import { randomBytes } from "crypto";

// Same tier-A allowance the watchlist-hermetic-smoke uses. Lets the careers-
// page fetcher hit 127.0.0.1; SSRF guard rejects private IPs otherwise.
process.env.MC_ALLOW_PRIVATE_FETCH = "1";

import { runWatchlist } from "@/scheduler/jobs/job-watcher";
import { runPostingDigest } from "@/scheduler/jobs/posting-digest";
import { _resetNegativeFilterCache } from "@/lib/postings/negative-filters";
import { parseNegativeFilters, normalizeNegativeFilterForDedup } from "@/lib/repositories/settings";

const prisma = new PrismaClient();

let passes = 0;
let fails = 0;
function pass(msg: string) { console.log(`[PASS] ${msg}`); passes++; }
function fail(msg: string, detail?: unknown) { console.error(`[FAIL] ${msg}`, detail ?? ""); fails++; }

function htmlForPostings(postings: { slug: string; title: string }[]): string {
    const links = postings.map(p =>
        `<a href="/careers/jobs/${p.slug}">${p.title}</a>`
    ).join("\n");
    return `<!doctype html><html><body>${links}</body></html>`;
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
    async start() { await new Promise<void>(r => this.server.listen(0, "127.0.0.1", () => r())); this.port = (this.server.address() as AddressInfo).port; }
    setPostings(p: { slug: string; title: string }[]) { this.currentPostings = p; }
    rootUrl() { return `http://127.0.0.1:${this.port}/careers/`; }
    async stop() { await new Promise<void>(r => this.server.close(() => r())); }
}

async function snapshotGlobalNegativeFilters(): Promise<{ existed: boolean; raw: string }> {
    const row = await prisma.globalSetting.findUnique({ where: { id: "global" } });
    if (!row) return { existed: false, raw: "[]" };
    return { existed: true, raw: row.globalNegativeFilters };
}

async function setGlobalNegativeFilters(patterns: string[]): Promise<void> {
    _resetNegativeFilterCache(); // ensure new patterns get compiled (cache is keyed by JSON string)
    const json = JSON.stringify(patterns);
    const existing = await prisma.globalSetting.findUnique({ where: { id: "global" } });
    if (existing) {
        await prisma.globalSetting.update({
            where: { id: "global" },
            data: { globalNegativeFilters: json },
        });
    } else {
        await prisma.globalSetting.create({
            data: {
                id: "global",
                isDarkMode: true,
                viewHuesEnabled: true,
                viewHues: "{}",
                dashOrder: "[]",
                dashTitles: "{}",
                globalNegativeFilters: json,
                version: 1,
            },
        });
    }
}

async function restoreGlobalNegativeFilters(snap: { existed: boolean; raw: string }): Promise<void> {
    _resetNegativeFilterCache();
    if (!snap.existed) {
        await prisma.globalSetting.delete({ where: { id: "global" } }).catch(() => undefined);
        return;
    }
    await prisma.globalSetting.update({
        where: { id: "global" },
        data: { globalNegativeFilters: snap.raw },
    }).catch(() => undefined);
}

async function main() {
    const tag = randomBytes(4).toString("hex");
    const userId = `negfilt-smoke-user-${tag}`;
    const watchlistIds: string[] = [];
    const fixture = new FixtureServer();
    const globalSnap = await snapshotGlobalNegativeFilters();

    try {
        await fixture.start();

        // ────────────────────────────────────────────────────────────────
        // Part 0: parseNegativeFilters dedup uses case + punctuation +
        // whitespace normalization. Pure unit-style — no DB / no fixture.
        // ────────────────────────────────────────────────────────────────
        // Legacy `{career,side}` shape with "Sr" on one side and "Sr." on
        // the other should collapse to a single entry. Without the
        // normalizer the parser would emit both, producing redundant regex
        // patterns that look identical to a human.
        const legacyRaw = JSON.stringify({ career: ["Sr"], side: ["Sr.", "Sr  Engineer"] });
        const parsed = parseNegativeFilters(legacyRaw);
        if (parsed.length !== 2) {
            fail(`dedup: expected 2 entries after collapsing "Sr"/"Sr." + "Sr Engineer"/"Sr  Engineer", got ${parsed.length} (${parsed.join(" | ")})`);
        } else pass(`dedup: legacy {career,side} collapses Sr/Sr. and folds double-space → ${parsed.join(" | ")}`);
        // Regex-metachar invariant: `Sr\.` (literal "Sr.") and `Sr` must
        // stay distinct — they target different inputs.
        const escapedKey = normalizeNegativeFilterForDedup("Sr\\.");
        const plainKey = normalizeNegativeFilterForDedup("Sr");
        if (escapedKey === plainKey) {
            fail(`dedup: escaped "Sr\\." collapsed onto "Sr" (regex intent lost): "${escapedKey}" === "${plainKey}"`);
        } else pass(`dedup: "Sr\\." stays distinct from "Sr" (regex metachars preserved)`);

        await prisma.user.create({ data: { id: userId, email: `negfilt-smoke-${tag}@example.invalid` } });
        await setGlobalNegativeFilters(["Senior", "Lead"]);

        // ────────────────────────────────────────────────────────────────
        // Part 1: per-posting dispatch (notificationMode='each')
        // ────────────────────────────────────────────────────────────────
        const wEach = await prisma.watchlist.create({
            data: {
                userId,
                name: `Each WL ${tag}`,
                kind: "careers-page",
                config: JSON.stringify({
                    kind: "careers-page",
                    rootUrl: fixture.rootUrl(),
                    linkPattern: "/careers/jobs/",
                    companyName: "Each Co",
                }),
                negativeFilters: JSON.stringify(["Intern"]),
                notificationMode: "each",
                scheduleMinutes: 60,
            },
        });
        watchlistIds.push(wEach.id);

        // Fixture: 4 postings.
        //   - "Senior Engineer"     → global ("Senior")  → DROPPED at ingest (not stored)
        //   - "Lead Designer"       → global ("Lead")    → DROPPED at ingest (not stored)
        //   - "Software Intern"     → per-watchlist ("Intern") → stored, notification suppressed
        //   - "Software Engineer"   → survives both           → stored + NOTIFY
        fixture.setPostings([
            { slug: "10", title: "Senior Engineer" },
            { slug: "20", title: "Lead Designer" },
            { slug: "30", title: "Software Intern" },
            { slug: "40", title: "Software Engineer" },
        ]);

        const r1 = await runWatchlist(wEach.id);
        if (r1.error) fail(`per-posting run errored: ${r1.error}`);
        else pass("per-posting run completed");
        // Global-filtered Senior/Lead are dropped at ingest; the per-watchlist-
        // filtered Intern + the survivor Engineer are stored. So 2 rows land.
        if (r1.newPostings !== 2) fail(`per-posting: expected 2 newPostings (Senior/Lead dropped at ingest), got ${r1.newPostings}`);
        else pass("per-posting: 2 postings created (global-filtered Senior/Lead dropped at ingest)");

        const eachRows = await prisma.jobPosting.findMany({ where: { watchlistId: wEach.id } });
        if (eachRows.length !== 2) fail(`per-posting: expected 2 JobPosting rows (global drop, per-watchlist stored), got ${eachRows.length}`);
        else pass("per-posting: 2 JobPosting rows — global filter drops at ingest, per-watchlist does not");
        const eachTitles = new Set(eachRows.map(r => r.title));
        if (eachTitles.has("Senior Engineer") || eachTitles.has("Lead Designer")) fail(`per-posting: a global-filtered title was stored: ${[...eachTitles].join(" | ")}`);
        else pass("per-posting: neither global-filtered title (Senior/Lead) was stored");

        // Only the "Software Engineer" notification should fire.
        // payload.postingId is set per posting; we match on title via the parent row.
        const eachNotifs = await prisma.notification.findMany({
            where: { userId, kind: "posting" },
        });
        const eachNotifTitles = new Set(eachNotifs.map(n => n.title));
        if (eachNotifs.length !== 1) fail(`per-posting: expected exactly 1 notification, got ${eachNotifs.length} (${[...eachNotifTitles].join(" | ")})`);
        else pass("per-posting: exactly 1 notification fired (Senior/Lead/Intern suppressed)");
        const survivorTitle = "Each Co — Software Engineer";
        if (!eachNotifTitles.has(survivorTitle)) fail(`per-posting: notification title mismatch, expected "${survivorTitle}" in ${[...eachNotifTitles].join(" | ")}`);
        else pass("per-posting: notification is for the un-filtered posting");

        // ────────────────────────────────────────────────────────────────
        // Part 2: digest dispatch (notificationMode='digest')
        // ────────────────────────────────────────────────────────────────
        // Use a separate watchlist with mode='digest'. Insert postings via
        // prisma.create so we don't need to wire the fetcher path again — the
        // digest job just reads the JobPosting table.
        const wDigest = await prisma.watchlist.create({
            data: {
                userId,
                name: `Digest WL ${tag}`,
                kind: "careers-page",
                config: JSON.stringify({
                    kind: "careers-page",
                    rootUrl: fixture.rootUrl(),
                    linkPattern: "/careers/jobs/",
                    companyName: "Digest Co",
                }),
                negativeFilters: JSON.stringify(["Manager"]),
                notificationMode: "digest",
                scheduleMinutes: 60,
            },
        });
        watchlistIds.push(wDigest.id);

        async function addDigestPosting(slug: string, title: string) {
            await prisma.jobPosting.create({
                data: {
                    watchlistId: wDigest.id,
                    externalId: `${tag}-${slug}`,
                    company: "Digest Co",
                    title,
                    sourceUrl: `https://example.invalid/careers/jobs/${slug}`,
                    status: "new",
                    raw: JSON.stringify({}),
                },
            });
        }
        await addDigestPosting("d1", "Senior Backend Engineer"); // culled (global "Senior")
        await addDigestPosting("d2", "Lead Designer");           // culled (global "Lead")
        await addDigestPosting("d3", "Product Manager");         // culled (per-WL "Manager")
        await addDigestPosting("d4", "Software Engineer");       // SURVIVES
        await addDigestPosting("d5", "Data Analyst");            // SURVIVES

        const r2 = await runPostingDigest();
        if (r2.summarized < 1) fail(`digest: expected ≥ 1 summarized, got ${r2.summarized}`);
        else pass("digest: dispatched");

        const digestNotifs = await prisma.notification.findMany({
            where: { userId, kind: "posting", payload: { contains: '"type":"posting-digest"' } },
            orderBy: { createdAt: "asc" },
        });
        if (digestNotifs.length !== 1) fail(`digest: expected 1 digest notification, got ${digestNotifs.length}`);
        else pass("digest: exactly 1 digest notification fired");

        if (digestNotifs[0]) {
            const payload = JSON.parse(digestNotifs[0].payload);
            if (payload.count !== 2) fail(`digest: payload.count = ${payload.count}, expected 2 (only survivors)`);
            else pass("digest: payload.count = 2 (Senior/Lead/Manager filtered out)");
            if (!Array.isArray(payload.postingIds) || payload.postingIds.length !== 2) {
                fail(`digest: postingIds wrong length: ${JSON.stringify(payload.postingIds)}`);
            } else pass("digest: postingIds list contains exactly the 2 survivors");
            if (!digestNotifs[0].title.includes("2 new posting")) fail(`digest: title mismatch: ${digestNotifs[0].title}`);
            else pass("digest: title reflects survivor count");
            if (!digestNotifs[0].body || /Senior|Lead|Manager/.test(digestNotifs[0].body)) {
                fail(`digest: body should not preview any filtered posting: ${digestNotifs[0].body}`);
            } else pass("digest: body preview excludes filtered titles");
        }

        // ────────────────────────────────────────────────────────────────
        // Part 3: watermark advances even when every window posting culled
        // ────────────────────────────────────────────────────────────────
        // After part 2, lastDigestAt is set to the max firstSeenAt of the
        // surviving cohort (d4 or d5 — both inserted in close succession).
        // Now add ONLY filtered-out postings and re-run. Pre-fix, the digest
        // would skip dispatch AND skip watermark advance, leaving the culled
        // cohort to be reconsidered every tick. Post-fix, dispatch is skipped
        // but watermark advances.
        const wlBefore = await prisma.watchlist.findUnique({ where: { id: wDigest.id } });
        const lastDigestBefore = wlBefore?.lastDigestAt?.getTime() ?? 0;

        // Insert filtered-out postings with firstSeenAt strictly after the
        // current watermark so they land inside the next window.
        const baseT = new Date(lastDigestBefore + 10);
        await prisma.jobPosting.create({
            data: {
                watchlistId: wDigest.id,
                externalId: `${tag}-d6`,
                company: "Digest Co",
                title: "Senior Manager", // culled by BOTH filter sets
                sourceUrl: "https://example.invalid/careers/jobs/d6",
                status: "new",
                firstSeenAt: baseT,
                raw: JSON.stringify({}),
            },
        });
        await prisma.jobPosting.create({
            data: {
                watchlistId: wDigest.id,
                externalId: `${tag}-d7`,
                company: "Digest Co",
                title: "Engineering Manager",
                sourceUrl: "https://example.invalid/careers/jobs/d7",
                status: "new",
                firstSeenAt: new Date(baseT.getTime() + 5),
                raw: JSON.stringify({}),
            },
        });

        const r3 = await runPostingDigest();
        if (r3.summarized !== 0) fail(`watermark: expected 0 summarized (all culled), got ${r3.summarized}`);
        else pass("watermark: 0 summarized when all postings culled");

        const digestNotifsAfter = await prisma.notification.findMany({
            where: { userId, kind: "posting", payload: { contains: '"type":"posting-digest"' } },
        });
        if (digestNotifsAfter.length !== 1) fail(`watermark: expected still 1 digest notif (no new dispatch), got ${digestNotifsAfter.length}`);
        else pass("watermark: no new digest notification dispatched");

        const wlAfter = await prisma.watchlist.findUnique({ where: { id: wDigest.id } });
        const lastDigestAfter = wlAfter?.lastDigestAt?.getTime() ?? 0;
        if (lastDigestAfter <= lastDigestBefore) {
            fail(`watermark: lastDigestAt did not advance after all-culled window (${lastDigestBefore} → ${lastDigestAfter})`);
        } else {
            pass("watermark: lastDigestAt advanced past culled cohort");
        }

        // ────────────────────────────────────────────────────────────────
        // Part 4: empty window — watermark stays put (PB-3 unchanged)
        // ────────────────────────────────────────────────────────────────
        const r4 = await runPostingDigest();
        if (r4.summarized !== 0) fail(`empty: expected 0 summarized, got ${r4.summarized}`);
        else pass("empty: 0 summarized when window has no postings");
        const wlAfter4 = await prisma.watchlist.findUnique({ where: { id: wDigest.id } });
        if ((wlAfter4?.lastDigestAt?.getTime() ?? 0) !== lastDigestAfter) {
            fail(`empty: lastDigestAt should be unchanged on empty window, was ${lastDigestAfter}, now ${wlAfter4?.lastDigestAt?.getTime()}`);
        } else pass("empty: lastDigestAt unchanged on empty window (PB-3 preserved)");

        // ────────────────────────────────────────────────────────────────
        // Part 5: global filter applies to side-tracked watchlists too
        // ────────────────────────────────────────────────────────────────
        // The shared-blocklist model: a global pattern culls postings
        // regardless of watchlist.track. Originally the schema split career
        // and side filters apart, which let an "anduril" entry on the career
        // list miss an Anduril job surfaced by a side watchlist. We use
        // runWatchlist via the fixture server (notificationMode='each')
        // instead of runPostingDigest here — the digest path is shared with
        // the live dev scheduler (mission-control-scheduler-dev), which races
        // on lastDigestAt and makes count assertions flaky. The job-watcher
        // path is per-posting so the assertions are about individual
        // dispatches, immune to watermark races.
        await setGlobalNegativeFilters(["Senior", "Lead", "Manager"]);

        // 4 fixture postings on a SIDE-tracked watchlist. Every global
        // pattern applies regardless of track now, so:
        //   - "Senior Warehouse Associate" → culled
        //   - "Lead Driver"                 → culled
        //   - "Engineering Manager"         → culled
        //   - "Warehouse Picker"            → SURVIVES
        fixture.setPostings([
            { slug: "s-senior", title: "Senior Warehouse Associate" }, // global "Senior" → CULLED
            { slug: "s-lead",   title: "Lead Driver" },                 // global "Lead"   → CULLED
            { slug: "s-mgr",    title: "Engineering Manager" },         // global "Manager"→ CULLED
            { slug: "s-plain",  title: "Warehouse Picker" },            // no match         → SURVIVES
        ]);
        const wSide = await prisma.watchlist.create({
            data: {
                userId,
                name: `Side WL ${tag}`,
                kind: "careers-page",
                track: "side",
                config: JSON.stringify({
                    kind: "careers-page",
                    rootUrl: fixture.rootUrl(),
                    linkPattern: "/careers/jobs/",
                    companyName: "Side Co",
                }),
                notificationMode: "each",
                scheduleMinutes: 60,
            },
        });
        watchlistIds.push(wSide.id);

        const beforeRun = Date.now();
        const r5 = await runWatchlist(wSide.id);
        if (r5.error) fail(`shared-blocklist: side run errored: ${r5.error}`);
        else pass("shared-blocklist: side run completed");
        // Senior/Lead/Manager are all GLOBAL-filtered → dropped at ingest; only
        // "Warehouse Picker" survives and is stored.
        if (r5.newPostings !== 1) fail(`shared-blocklist: expected 1 newPosting (global Senior/Lead/Manager dropped at ingest), got ${r5.newPostings}`);
        else pass("shared-blocklist: 1 side row created — global filters drop Senior/Lead/Manager at ingest");

        const sideNotifs = await prisma.notification.findMany({
            where: {
                userId,
                kind: "posting",
                createdAt: { gte: new Date(beforeRun - 1) },
                title: { contains: "Side Co —" },
            },
            orderBy: { createdAt: "asc" },
        });
        const sideTitles = new Set(sideNotifs.map(n => n.title));
        if (sideNotifs.length !== 1) fail(`shared-blocklist: expected 1 side notification, got ${sideNotifs.length} (${[...sideTitles].join(" | ")})`);
        else pass("shared-blocklist: exactly 1 side notification fired (global filters DO cull side postings)");
        if (sideTitles.has("Side Co — Senior Warehouse Associate")) fail(`shared-blocklist: "Senior Warehouse Associate" leaked through despite global "Senior"`);
        else pass(`shared-blocklist: "Senior Warehouse Associate" suppressed by global "Senior"`);
        if (sideTitles.has("Side Co — Lead Driver")) fail(`shared-blocklist: "Lead Driver" leaked through despite global "Lead"`);
        else pass(`shared-blocklist: "Lead Driver" suppressed by global "Lead"`);
        if (sideTitles.has("Side Co — Engineering Manager")) fail(`shared-blocklist: "Engineering Manager" leaked through despite global "Manager"`);
        else pass(`shared-blocklist: "Engineering Manager" suppressed by global "Manager"`);
        if (!sideTitles.has("Side Co — Warehouse Picker")) fail(`shared-blocklist: missing "Warehouse Picker" survivor`);
        else pass(`shared-blocklist: "Warehouse Picker" survived (no matching pattern)`);
    } finally {
        await prisma.notification.deleteMany({ where: { userId } }).catch(() => undefined);
        for (const id of watchlistIds) {
            await prisma.jobPosting.deleteMany({ where: { watchlistId: id } }).catch(() => undefined);
            await prisma.watchlist.delete({ where: { id } }).catch(() => undefined);
        }
        await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
        await restoreGlobalNegativeFilters(globalSnap);
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
