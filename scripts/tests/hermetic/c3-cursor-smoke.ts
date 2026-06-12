/**
 * Hermetic smoke for the closed-jobs C3 sweep cursor (P3.3 — OQ6a + OQ7a).
 *
 *   DATABASE_URL="file:./dev.db" EMAIL_ENABLED=0 npx tsx scripts/tests/hermetic/c3-cursor-smoke.ts
 *
 * Stubs globalThis.fetch (no real network, no fixture HTTP server) and drives
 * scheduler/jobs/job-watcher.ts:runWatchlist against throwaway rows in dev.db.
 * Asserts:
 *
 *   (a) OQ6a — steady-state cursor advance. C3 candidates that are selected
 *       into the take-window but SKIPPED (fetch-seen on a first-party kind)
 *       still get lastProbedAt stamped, so the ORDER BY lastProbedAt ASC
 *       rotation advances: tick 1 stamps exactly the budget's worth of rows,
 *       tick 2 picks up the still-NULL rows, and after two ticks every row is
 *       stamped. (Pre-fix, skipped candidates kept lastProbedAt = NULL forever
 *       and jammed the window.) lastProbedAt means "last considered by a probe
 *       sweep", not "actually probed".
 *
 *   (b) OQ7a — first-party kinds (careers-page here) do NOT GET-probe
 *       fetch-seen rows (zero probe fetches to posting URLs), while aggregator
 *       kinds (linkedin) DO probe fetch-seen rows: a closed-marker on the
 *       detail page flips the row to status="closed" even though the search
 *       feed still lists it (listing-presence ≠ detail-page-open).
 *
 *   (c) OQ5a — two-tick close confirmation. The first "closed" verdict only
 *       stamps pendingClosedAt (status stays "new", RunResult.closed === 0);
 *       the second consecutive one flips the row. The tick-2 fetch re-seeing
 *       the row (seen-again lastSeenAt bump) does NOT clear the pending stamp
 *       — fetch-presence isn't alive evidence on an aggregator feed. An
 *       "alive" verdict (row B) keeps pendingClosedAt null throughout.
 *
 * Throwaway user + watchlists + postings with unique ids (concurrent-safe);
 * full cleanup + global-negative-filter restore in finally.
 */
import { PrismaClient } from "@prisma/client";
import { createHash, randomBytes } from "crypto";

// Real probes must run (through the fetch stub) — never the bypass.
delete process.env.MC_LIVENESS_BYPASS;
process.env.EMAIL_ENABLED = "0";

import { runWatchlist, c3BudgetForKind, AGGREGATOR_KINDS } from "@/scheduler/jobs/job-watcher";

const prisma = new PrismaClient();

let passes = 0;
let fails = 0;
function pass(msg: string) { console.log(`[PASS] ${msg}`); passes++; }
function fail(msg: string, detail?: unknown) { console.error(`[FAIL] ${msg}`, detail ?? ""); fails++; }

/** Mirrors job-watcher's externalIdFor (sha256 of company|title|sourceUrl). */
function externalIdFor(company: string, title: string, sourceUrl: string): string {
    return createHash("sha256").update(`${company}|${title}|${sourceUrl}`).digest("hex");
}

// ─── fetch stub ────────────────────────────────────────────────────────────

interface MockHandler {
    matches: (url: string) => boolean;
    respond: (url: string) => Response;
}

const handlers: MockHandler[] = [];
const fetchLog: string[] = [];
const originalFetch = globalThis.fetch;

function installFetchStub() {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        fetchLog.push(url);
        for (const h of handlers) {
            if (h.matches(url)) return h.respond(url);
        }
        throw new Error(`unstubbed fetch: ${url}`);
    }) as typeof fetch;
}

function respond200(body: string, finalUrl?: string): Response {
    const res = new Response(body, { status: 200, headers: { "content-type": "text/html" } });
    if (finalUrl) Object.defineProperty(res, "url", { value: finalUrl, writable: false });
    return res;
}

/** Count fetches matching `fragment` issued at or after log index `from`. */
function fetchCountSince(from: number, fragment: string): number {
    return fetchLog.slice(from).filter(u => u.includes(fragment)).length;
}

async function main() {
    const tag = randomBytes(4).toString("hex");
    const userId = `c3-cursor-smoke-${tag}`;
    const watchlistIds: string[] = [];

    installFetchStub();

    // Global negative filters could swallow the fixture titles — clear for the
    // run, restore in finally (same pattern as job-watcher-scale-regression).
    const globalRow = await prisma.globalSetting.findUnique({ where: { id: "global" } }).catch(() => null);
    const filterSnapshot = globalRow?.globalNegativeFilters ?? null;
    if (globalRow && filterSnapshot !== "[]") {
        await prisma.globalSetting.update({ where: { id: "global" }, data: { globalNegativeFilters: "[]" } });
    }

    try {
        await prisma.user.create({ data: { id: userId, email: `c3-cursor-${tag}@example.invalid` } });
        const anHourAgo = new Date(Date.now() - 60 * 60 * 1000);

        // ════ (a) + (b-first-party): careers-page — skipped candidates stamp,
        //      fetch-seen rows never probed ════════════════════════════════
        const FP_COMPANY = "C3 First-Party Co";
        const fpRoot = `https://c3-${tag}.example.invalid/careers/`;
        const fpBudget = c3BudgetForKind("careers-page");
        const FP_ROWS = fpBudget + 3; // strictly more rows than one tick's window

        const fpPostings = Array.from({ length: FP_ROWS }, (_, i) => {
            const title = `C3 Posting ${i}`;
            const sourceUrl = `${fpRoot}jobs/p-${i}`;
            return { title, sourceUrl, externalId: externalIdFor(FP_COMPANY, title, sourceUrl) };
        });
        handlers.push({
            matches: (u) => u === fpRoot,
            respond: () => respond200(
                `<!doctype html><html><body>${fpPostings.map(p => `<a href="/careers/jobs/${p.sourceUrl.split("/").pop()}">${p.title}</a>`).join("\n")}</body></html>`,
            ),
        });

        const fpWatchlist = await prisma.watchlist.create({
            data: {
                userId,
                name: `C3 cursor first-party ${tag}`,
                kind: "careers-page",
                config: JSON.stringify({
                    kind: "careers-page",
                    rootUrl: fpRoot,
                    linkPattern: "/careers/jobs/",
                    companyName: FP_COMPANY,
                }),
                scheduleMinutes: 60,
                lastRunAt: anHourAgo,
                lastSuccessAt: anHourAgo, // NOT first run → close-detection + C3 active
            },
        });
        watchlistIds.push(fpWatchlist.id);

        // Pre-seed every posting as an existing fresh row: status="new",
        // lastSeenAt fresh (never stale), lastProbedAt NULL (never considered).
        for (const p of fpPostings) {
            await prisma.jobPosting.create({
                data: {
                    watchlistId: fpWatchlist.id,
                    externalId: p.externalId,
                    company: FP_COMPANY,
                    title: p.title,
                    sourceUrl: p.sourceUrl,
                    status: "new",
                    raw: "{}",
                },
            });
        }

        // ── tick 1 ──
        const probeLogMark1 = fetchLog.length;
        const r1 = await runWatchlist(fpWatchlist.id);
        if (r1.error) fail(`(a) tick 1 errored: ${r1.error}`);
        else pass("(a) tick 1 ran clean");

        const stampedAfterTick1 = await prisma.jobPosting.count({
            where: { watchlistId: fpWatchlist.id, lastProbedAt: { not: null } },
        });
        if (stampedAfterTick1 === fpBudget) {
            pass(`(a) OQ6a tick 1: exactly the take-window (budget=${fpBudget}) got lastProbedAt stamped despite ALL being skipped as fetch-seen`);
        } else {
            fail(`(a) OQ6a tick 1: expected ${fpBudget} stamped rows, got ${stampedAfterTick1} — skipped candidates not stamping (cursor jam)`);
        }
        const fpProbes1 = fetchCountSince(probeLogMark1, "/careers/jobs/");
        if (fpProbes1 === 0) pass("(b) OQ7a first-party: tick 1 issued ZERO probe GETs to posting URLs (fetch-seen rows skipped)");
        else fail(`(b) OQ7a first-party: tick 1 issued ${fpProbes1} probe GETs to posting URLs, expected 0`);

        // ── tick 2 — the still-NULL rows sort first and get picked up ──
        const probeLogMark2 = fetchLog.length;
        const r2 = await runWatchlist(fpWatchlist.id);
        if (r2.error) fail(`(a) tick 2 errored: ${r2.error}`);
        else pass("(a) tick 2 ran clean");

        const unstampedAfterTick2 = await prisma.jobPosting.count({
            where: { watchlistId: fpWatchlist.id, lastProbedAt: null },
        });
        if (unstampedAfterTick2 === 0) {
            pass(`(a) OQ6a tick 2: window advanced — all ${FP_ROWS} rows now stamped (fresh NULL rows selected, none re-jammed)`);
        } else {
            fail(`(a) OQ6a tick 2: ${unstampedAfterTick2} rows still have lastProbedAt=NULL — rotation did not advance`);
        }
        const fpProbes2 = fetchCountSince(probeLogMark2, "/careers/jobs/");
        if (fpProbes2 === 0) pass("(b) OQ7a first-party: tick 2 also issued zero posting-URL probes");
        else fail(`(b) OQ7a first-party: tick 2 issued ${fpProbes2} probe GETs, expected 0`);

        const nonNew = await prisma.jobPosting.count({
            where: { watchlistId: fpWatchlist.id, status: { not: "new" } },
        });
        if (nonNew === 0) pass("(a) first-party rows all still status='new' (stamping never closed anything)");
        else fail(`(a) ${nonNew} first-party rows changed status — stamping must be status-neutral`);

        // ════ (b-aggregator): linkedin — fetch-seen rows ARE probed ════════
        const LI_COMPANY = "Acme C3 Corp";
        const liViewA = `https://www.linkedin.com/jobs/view/c3-a-${tag}`;
        const liViewB = `https://www.linkedin.com/jobs/view/c3-b-${tag}`;
        const liCards = [
            { title: "C3 Role A", url: liViewA },
            { title: "C3 Role B", url: liViewB },
        ];
        // Guest-search feed lists BOTH postings (so both are fetch-seen).
        handlers.push({
            matches: (u) => u.includes("linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search"),
            respond: () => respond200(
                `<!doctype html><html><body><ul>${liCards.map(c => `
                    <li>
                        <a class="base-card__full-link" href="${c.url}?refId=track-${tag}"><span class="sr-only">${c.title}</span></a>
                        <h3 class="base-search-card__title">${c.title}</h3>
                        <h4 class="base-search-card__subtitle">${LI_COMPANY}</h4>
                        <span class="job-search-card__location">Remote</span>
                    </li>`).join("\n")}</ul></body></html>`,
            ),
        });
        // Detail pages: A carries a closed marker (still listed in search but
        // no longer accepting applications); B is a live posting.
        handlers.push({
            matches: (u) => u.startsWith(liViewA),
            respond: (u) => respond200(
                `<html><body><div class="top-card-layout">C3 Role A</div><p>No longer accepting applications</p></body></html>`, u,
            ),
        });
        handlers.push({
            matches: (u) => u.startsWith(liViewB),
            respond: (u) => respond200(
                `<html><body><div class="top-card-layout">C3 Role B</div><div class="description__text">Live</div></body></html>`, u,
            ),
        });

        const liWatchlist = await prisma.watchlist.create({
            data: {
                userId,
                name: `C3 cursor aggregator ${tag}`,
                kind: "linkedin",
                config: JSON.stringify({
                    kind: "linkedin",
                    keywords: `c3 smoke ${tag}`,
                    companyName: LI_COMPANY,
                }),
                scheduleMinutes: 60,
                lastRunAt: anHourAgo,
                lastSuccessAt: anHourAgo,
            },
        });
        watchlistIds.push(liWatchlist.id);

        const liRows = liCards.map(c => ({
            ...c,
            externalId: externalIdFor(LI_COMPANY, c.title, c.url),
        }));
        for (const r of liRows) {
            await prisma.jobPosting.create({
                data: {
                    watchlistId: liWatchlist.id,
                    externalId: r.externalId,
                    company: LI_COMPANY,
                    title: r.title,
                    sourceUrl: r.url,
                    status: "new",
                    raw: "{}",
                },
            });
        }

        // ── aggregator tick 1 — first closed verdict stamps pending only ──
        const probeLogMark3 = fetchLog.length;
        const rLi = await runWatchlist(liWatchlist.id);
        if (rLi.error) fail(`(b) aggregator tick 1 errored: ${rLi.error}`);
        else pass("(b) aggregator tick 1 ran clean");

        const liProbes = fetchCountSince(probeLogMark3, "/jobs/view/");
        if (liProbes === 2) pass("(b) OQ7a aggregator: BOTH fetch-seen rows were GET-probed (seen-exclusion dropped for linkedin)");
        else fail(`(b) OQ7a aggregator: expected 2 posting-URL probes, got ${liProbes}`);

        let rowA = await prisma.jobPosting.findUnique({
            where: { watchlistId_externalId: { watchlistId: liWatchlist.id, externalId: liRows[0].externalId } },
        });
        let rowB = await prisma.jobPosting.findUnique({
            where: { watchlistId_externalId: { watchlistId: liWatchlist.id, externalId: liRows[1].externalId } },
        });
        if (rowA?.status === "new" && rowA.pendingClosedAt != null) {
            pass("(c) OQ5a tick 1: closed-marker row got pendingClosedAt stamped, status still 'new' (no one-tick flip)");
        } else {
            fail(`(c) OQ5a tick 1: expected row A status='new' + pendingClosedAt set, got status='${rowA?.status}' pendingClosedAt=${rowA?.pendingClosedAt}`);
        }
        if (rowA?.removedAt == null) pass("(c) OQ5a tick 1: removedAt NOT set on first strike");
        else fail("(c) OQ5a tick 1: removedAt set on first strike — should wait for confirmation");
        if (rowB?.status === "new" && rowB.pendingClosedAt == null) {
            pass("(c) OQ5a tick 1: alive row stays 'new' with pendingClosedAt null");
        } else {
            fail(`(c) OQ5a tick 1: expected row B 'new' + null pending, got status='${rowB?.status}' pendingClosedAt=${rowB?.pendingClosedAt}`);
        }
        if (rowA?.lastProbedAt != null && rowB?.lastProbedAt != null) {
            pass("(b) OQ6a aggregator: both probed rows got lastProbedAt stamped");
        } else {
            fail("(b) OQ6a aggregator: probed rows missing lastProbedAt stamp");
        }
        if (rLi.closed === 0) pass("(c) OQ5a tick 1: RunResult.closed === 0 (first strike not counted as a close)");
        else fail(`(c) OQ5a tick 1: RunResult.closed expected 0, got ${rLi.closed}`);

        // ── aggregator tick 2 — second consecutive closed verdict confirms ──
        // The search feed still lists row A, so the tick-2 fetch re-sees it
        // (seen-again lastSeenAt bump). The flip below therefore also proves
        // fetch-presence does NOT clear pendingClosedAt.
        const probeLogMark4 = fetchLog.length;
        const rLi2 = await runWatchlist(liWatchlist.id);
        if (rLi2.error) fail(`(c) aggregator tick 2 errored: ${rLi2.error}`);
        else pass("(c) aggregator tick 2 ran clean");

        const liProbes2 = fetchCountSince(probeLogMark4, "/jobs/view/");
        if (liProbes2 === 2) pass("(c) OQ5a tick 2: both rows GET-probed again (pending row stays in the C3 rotation)");
        else fail(`(c) OQ5a tick 2: expected 2 posting-URL probes, got ${liProbes2}`);

        rowA = await prisma.jobPosting.findUnique({
            where: { watchlistId_externalId: { watchlistId: liWatchlist.id, externalId: liRows[0].externalId } },
        });
        rowB = await prisma.jobPosting.findUnique({
            where: { watchlistId_externalId: { watchlistId: liWatchlist.id, externalId: liRows[1].externalId } },
        });
        if (rowA?.status === "closed" && rowA.removedAt != null) {
            pass("(c) OQ5a tick 2: second consecutive closed verdict flipped the still-listed row to status='closed' (fetch-presence did not clear pending)");
        } else {
            fail(`(c) OQ5a tick 2: expected row A closed, got status='${rowA?.status}' removedAt=${rowA?.removedAt}`);
        }
        if (rowA?.pendingClosedAt == null) pass("(c) OQ5a tick 2: pendingClosedAt cleared on the confirmed flip");
        else fail(`(c) OQ5a tick 2: pendingClosedAt still set after flip: ${rowA?.pendingClosedAt}`);
        if (rowB?.status === "new" && rowB.pendingClosedAt == null) {
            pass("(c) OQ5a tick 2: live posting stays status='new', pendingClosedAt still null");
        } else {
            fail(`(c) OQ5a tick 2: expected row B 'new' + null pending, got status='${rowB?.status}' pendingClosedAt=${rowB?.pendingClosedAt}`);
        }
        if (rLi2.closed === 1) pass("(c) OQ5a tick 2: RunResult.closed === 1 (only the ACTUAL flip counted)");
        else fail(`(c) OQ5a tick 2: RunResult.closed expected 1, got ${rLi2.closed}`);

        // ── membership sanity: the aggregator set is exactly {linkedin, indeed} ──
        if (AGGREGATOR_KINDS.has("linkedin") && AGGREGATOR_KINDS.has("indeed") && AGGREGATOR_KINDS.size === 2) {
            pass("AGGREGATOR_KINDS is exactly {linkedin, indeed} (first-party ATS kinds keep the seen-exclusion)");
        } else {
            fail("AGGREGATOR_KINDS drifted", [...AGGREGATOR_KINDS]);
        }
    } finally {
        // Closure-summary notification (linkedin tick closed 1 row) + any strays.
        await prisma.notification.deleteMany({ where: { userId } }).catch(() => undefined);
        for (const id of watchlistIds) {
            await prisma.jobPosting.deleteMany({ where: { watchlistId: id } }).catch(() => undefined);
            await prisma.watchlist.delete({ where: { id } }).catch(() => undefined);
        }
        await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
        if (filterSnapshot !== null && filterSnapshot !== "[]") {
            await prisma.globalSetting.update({
                where: { id: "global" },
                data: { globalNegativeFilters: filterSnapshot },
            }).catch(() => undefined);
        }
        await prisma.$disconnect();
        globalThis.fetch = originalFetch;
        console.log(`\n${passes}/${passes + fails} steps passed`);
        if (fails === 0) console.log("All checks passed.");
    }
    if (fails > 0) process.exit(1);
}

main().catch(e => {
    console.error("Unhandled error:", e);
    process.exit(2);
});
