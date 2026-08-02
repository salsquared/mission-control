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
 *   (c) OQ5a — two-strike close confirmation, walked through ALL FOUR states of
 *       the confirm window ON THE C3 PATH (2026-08-02). Every branch of the C3
 *       partition is now covered here; previously the file backdated the stamp
 *       BEFORE its second tick, so C3's defer branch was never executed by any
 *       suite (deleting `else c3DeferredTooYoung++` and the window clause from
 *       the C3 confirm UPDATE left every hermetic suite green):
 *         c1. first "closed" verdict → pendingClosedAt stamped, status stays
 *             "new", RunResult.closed === 0.
 *         c2. DEFER — a second verdict seconds later must NOT confirm (stamp
 *             younger than MIN_PENDING_CLOSED_AGE_MS) and must leave the stamp
 *             UNTOUCHED, so a rapid-run burst can neither close nor postpone.
 *         c3. EXPIRE — a stamp older than MAX_PENDING_CLOSED_AGE_MS is not a
 *             strike any more: it must NOT confirm, and must be RE-STAMPED to
 *             this run's time (a fresh first strike). Otherwise one transient
 *             on day 1 plus one unrelated transient on day 30 sticky-closes.
 *         c4. CONFIRM — a stamp inside the window flips the row. The tick's
 *             fetch re-sees the row (seen-again lastSeenAt bump), so this also
 *             proves fetch-presence does NOT clear the pending stamp.
 *       An "alive" verdict (row B) keeps pendingClosedAt null throughout.
 *
 *   (d) Concurrency — a first strike never BACKDATES a stamp another run
 *       wrote. The candidate SELECT reads pendingClosedAt = NULL; a concurrent
 *       run stamps the row during the probe window (simulated by writing from
 *       inside the fetch stub, which is exactly that window); the first-strike
 *       UPDATE must then match nothing rather than overwrite the newer stamp
 *       with its own earlier `runAt` — which would shorten the OQ5a floor.
 *
 * Throwaway user + watchlists + postings with unique ids (concurrent-safe);
 * full cleanup + global-negative-filter restore in finally.
 */
import { PrismaClient } from "@prisma/client";
import { createHash, randomBytes } from "crypto";

// Real probes must run (through the fetch stub) — never the bypass.
delete process.env.MC_LIVENESS_BYPASS;
process.env.EMAIL_ENABLED = "0";

import {
    runWatchlist,
    c3BudgetForKind,
    AGGREGATOR_KINDS,
    MIN_PENDING_CLOSED_AGE_MS,
    MAX_PENDING_CLOSED_AGE_MS,
} from "@/scheduler/jobs/job-watcher";

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
    // Async-capable so a handler can do DB work IN the probe window — that is
    // the seam scenario (d) uses to simulate a concurrent run's write landing
    // between the candidate SELECT and the first-strike UPDATE.
    respond: (url: string) => Response | Promise<Response>;
}

const handlers: MockHandler[] = [];
const fetchLog: string[] = [];
const originalFetch = globalThis.fetch;

function installFetchStub() {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        fetchLog.push(url);
        for (const h of handlers) {
            if (h.matches(url)) return await h.respond(url);
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
            pass("(c1) OQ5a first strike: closed-marker row got pendingClosedAt stamped, status still 'new' (no one-tick flip)");
        } else {
            fail(`(c1) OQ5a first strike: expected row A status='new' + pendingClosedAt set, got status='${rowA?.status}' pendingClosedAt=${rowA?.pendingClosedAt}`);
        }
        if (rowA?.removedAt == null) pass("(c1) OQ5a first strike: removedAt NOT set on first strike");
        else fail("(c1) OQ5a first strike: removedAt set on first strike — should wait for confirmation");
        if (rowB?.status === "new" && rowB.pendingClosedAt == null) {
            pass("(c1) OQ5a first strike: alive row stays 'new' with pendingClosedAt null");
        } else {
            fail(`(c1) OQ5a first strike: expected row B 'new' + null pending, got status='${rowB?.status}' pendingClosedAt=${rowB?.pendingClosedAt}`);
        }
        if (rowA?.lastProbedAt != null && rowB?.lastProbedAt != null) {
            pass("(b) OQ6a aggregator: both probed rows got lastProbedAt stamped");
        } else {
            fail("(b) OQ6a aggregator: probed rows missing lastProbedAt stamp");
        }
        if (rLi.closed === 0) pass("(c1) OQ5a first strike: RunResult.closed === 0 (first strike not counted as a close)");
        else fail(`(c1) OQ5a first strike: RunResult.closed expected 0, got ${rLi.closed}`);

        const firstStrikeStamp = rowA?.pendingClosedAt ?? null;

        // ── (c2) aggregator tick 2, NO backdating — the DEFER branch ────────
        // This tick runs milliseconds after tick 1, so row A's stamp is far
        // younger than MIN_PENDING_CLOSED_AGE_MS. It is the rapid-re-run
        // transient the floor exists to absorb (a manual "Run now" landing
        // right after a scheduler tick), and it must neither confirm nor move
        // the stamp. Running it BEFORE the backdate is what gives the C3
        // defer branch coverage at all — backdating first, as this file used
        // to, meant C3 only ever saw an already-aged stamp.
        const probeLogMarkDefer = fetchLog.length;
        const rLiDefer = await runWatchlist(liWatchlist.id);
        if (rLiDefer.error) fail(`(c2) aggregator defer tick errored: ${rLiDefer.error}`);
        else pass("(c2) aggregator defer tick ran clean");

        const liProbesDefer = fetchCountSince(probeLogMarkDefer, "/jobs/view/");
        if (liProbesDefer === 2) pass("(c2) OQ5a floor: both rows GET-probed again (a pending row stays in the C3 rotation)");
        else fail(`(c2) OQ5a floor: expected 2 posting-URL probes, got ${liProbesDefer}`);

        const rowADefer = await prisma.jobPosting.findUnique({
            where: { watchlistId_externalId: { watchlistId: liWatchlist.id, externalId: liRows[0].externalId } },
        });
        if (rLiDefer.closed === 0) pass("(c2) OQ5a floor on the C3 path: rapid second verdict does NOT confirm (closed=0 — stamp too young)");
        else fail(`(c2) OQ5a floor on the C3 path: rapid second verdict confirmed a close (closed=${rLiDefer.closed}) — the floor is not enforced in the C3 partition`);
        if (rowADefer?.status === "new" && rowADefer.removedAt == null) {
            pass("(c2) OQ5a floor: row A still status='new', removedAt null after the rapid re-run");
        } else {
            fail(`(c2) OQ5a floor: row A perturbed by the rapid re-run — status='${rowADefer?.status}' removedAt=${rowADefer?.removedAt}`);
        }
        if (firstStrikeStamp != null && rowADefer?.pendingClosedAt?.getTime() === firstStrikeStamp.getTime()) {
            pass("(c2) OQ5a floor: the pending stamp is UNTOUCHED (not re-stamped — a run burst cannot postpone confirmation forever)");
        } else {
            fail(`(c2) OQ5a floor: pending stamp moved under a rapid re-run (${rowADefer?.pendingClosedAt?.toISOString()} vs ${firstStrikeStamp?.toISOString()})`);
        }

        // ── (c3) age the stamp past the CEILING — the EXPIRE branch ─────────
        // MAX_PENDING_CLOSED_AGE_MS (2026-08-02). A stamp this old is no
        // longer half of a two-strike close: without the ceiling, a transient
        // that stamped on day 1 and then sat through weeks of "unknown"
        // verdicts would be confirmed INSTANTLY by one unrelated transient on
        // day 30 — trivially older than the 30-minute floor.
        const expiredStamp = new Date(Date.now() - MAX_PENDING_CLOSED_AGE_MS - 60 * 60 * 1000);
        await prisma.jobPosting.update({
            where: { watchlistId_externalId: { watchlistId: liWatchlist.id, externalId: liRows[0].externalId } },
            data: { pendingClosedAt: expiredStamp },
        });

        const beforeExpireTick = new Date();
        const probeLogMarkExpire = fetchLog.length;
        const rLiExpire = await runWatchlist(liWatchlist.id);
        if (rLiExpire.error) fail(`(c3) aggregator expiry tick errored: ${rLiExpire.error}`);
        else pass("(c3) aggregator expiry tick ran clean");

        const liProbesExpire = fetchCountSince(probeLogMarkExpire, "/jobs/view/");
        if (liProbesExpire === 2) pass("(c3) OQ5a ceiling: both rows GET-probed again");
        else fail(`(c3) OQ5a ceiling: expected 2 posting-URL probes, got ${liProbesExpire}`);

        const rowAExpire = await prisma.jobPosting.findUnique({
            where: { watchlistId_externalId: { watchlistId: liWatchlist.id, externalId: liRows[0].externalId } },
        });
        if (rLiExpire.closed === 0) pass("(c3) OQ5a ceiling on the C3 path: an EXPIRED stamp does NOT confirm (closed=0)");
        else fail(`(c3) OQ5a ceiling on the C3 path: an expired stamp confirmed a close (closed=${rLiExpire.closed}) — a months-old transient can sticky-close`);
        if (rowAExpire?.status === "new" && rowAExpire.removedAt == null) {
            pass("(c3) OQ5a ceiling: row A still status='new', removedAt null");
        } else {
            fail(`(c3) OQ5a ceiling: row A flipped on an expired stamp — status='${rowAExpire?.status}' removedAt=${rowAExpire?.removedAt}`);
        }
        if (
            rowAExpire?.pendingClosedAt != null
            && rowAExpire.pendingClosedAt.getTime() >= beforeExpireTick.getTime()
        ) {
            pass("(c3) OQ5a ceiling: the expired stamp was RE-STAMPED to this run (treated as a fresh first strike, not dropped)");
        } else {
            fail(`(c3) OQ5a ceiling: expected a fresh re-stamp (>= ${beforeExpireTick.toISOString()}), got ${rowAExpire?.pendingClosedAt?.toISOString()}`);
        }

        // ── (c4) age the fresh stamp INTO the confirm window ────────────────
        // Simulates the re-stamped first strike having landed a real scheduler
        // tick ago (any normal cadence >= 60 min clears the 30-min floor), so
        // the next verdict may confirm. This also proves the ceiling only
        // defers a genuine close — it never makes one impossible.
        await prisma.jobPosting.update({
            where: { watchlistId_externalId: { watchlistId: liWatchlist.id, externalId: liRows[0].externalId } },
            data: { pendingClosedAt: new Date(Date.now() - MIN_PENDING_CLOSED_AGE_MS - 60_000) },
        });

        // ── aggregator confirming tick — verdict inside the window flips it ──
        // The search feed has listed row A on EVERY tick, so each one re-saw it
        // (seen-again lastSeenAt bump) without ever clearing the stamp. The flip
        // below therefore also proves fetch-presence is not alive evidence.
        const probeLogMark4 = fetchLog.length;
        const rLi2 = await runWatchlist(liWatchlist.id);
        if (rLi2.error) fail(`(c4) aggregator confirming tick errored: ${rLi2.error}`);
        else pass("(c4) aggregator confirming tick ran clean");

        const liProbes2 = fetchCountSince(probeLogMark4, "/jobs/view/");
        if (liProbes2 === 2) pass("(c4) OQ5a confirm: both rows GET-probed again (pending row stays in the C3 rotation)");
        else fail(`(c4) OQ5a confirm: expected 2 posting-URL probes, got ${liProbes2}`);

        rowA = await prisma.jobPosting.findUnique({
            where: { watchlistId_externalId: { watchlistId: liWatchlist.id, externalId: liRows[0].externalId } },
        });
        rowB = await prisma.jobPosting.findUnique({
            where: { watchlistId_externalId: { watchlistId: liWatchlist.id, externalId: liRows[1].externalId } },
        });
        if (rowA?.status === "closed" && rowA.removedAt != null) {
            pass("(c4) OQ5a confirm: second consecutive closed verdict flipped the still-listed row to status='closed' (fetch-presence did not clear pending)");
        } else {
            fail(`(c4) OQ5a confirm: expected row A closed, got status='${rowA?.status}' removedAt=${rowA?.removedAt}`);
        }
        if (rowA?.pendingClosedAt == null) pass("(c4) OQ5a confirm: pendingClosedAt cleared on the confirmed flip");
        else fail(`(c4) OQ5a confirm: pendingClosedAt still set after flip: ${rowA?.pendingClosedAt}`);
        if (rowB?.status === "new" && rowB.pendingClosedAt == null) {
            pass("(c4) OQ5a confirm: live posting stays status='new', pendingClosedAt still null");
        } else {
            fail(`(c4) OQ5a confirm: expected row B 'new' + null pending, got status='${rowB?.status}' pendingClosedAt=${rowB?.pendingClosedAt}`);
        }
        if (rLi2.closed === 1) pass("(c4) OQ5a confirm: RunResult.closed === 1 (only the ACTUAL flip counted)");
        else fail(`(c4) OQ5a confirm: RunResult.closed expected 1, got ${rLi2.closed}`);

        // ════ (d) a first strike never BACKDATES a concurrent stamp ════════
        // The stale-path partition routes a row to the first-strike list purely
        // on what the candidate SELECT saw (pendingClosedAt == null). Between
        // that SELECT and the UPDATE sits the whole probe round — minutes on
        // LinkedIn — and the per-watchlist mutex is per-PROCESS, so the web tier
        // and the scheduler can be in that window together. If the other run
        // stamps first, this run's UPDATE must not overwrite the newer stamp
        // with its own earlier `runAt`: that silently backdates the stamp and
        // shortens the OQ5a floor. `pendingClosedAt: null` in the UPDATE's WHERE
        // is what makes a stamp happen exactly once per pending episode.
        //
        // The fetch stub IS that window: the handler for the probed detail page
        // writes the "other run's" stamp before answering.
        const D3_COMPANY = "Acme D3 Corp";
        const d3SurvivorUrl = `https://www.linkedin.com/jobs/view/c3-d3s-${tag}`;
        const d3TargetUrl = `https://www.linkedin.com/jobs/view/c3-d3x-${tag}`;
        const d3SurvivorTitle = "D3 Survivor Role";
        // A stamp a couple of seconds AHEAD of this run's `runAt` — i.e. what a
        // run that started slightly later would write. Backdating it to `runAt`
        // is precisely the defect, so exact equality below is unambiguous.
        const d3ConcurrentStamp = new Date(Date.now() + 2000);
        let d3StampWritten = false;

        const d3Watchlist = await prisma.watchlist.create({
            data: {
                userId,
                name: `C3 cursor concurrent-stamp ${tag}`,
                kind: "linkedin",
                config: JSON.stringify({
                    kind: "linkedin",
                    keywords: `c3 d3run ${tag}`,
                    companyName: D3_COMPANY,
                }),
                scheduleMinutes: 60,
                lastRunAt: anHourAgo,
                lastSuccessAt: anHourAgo,
            },
        });
        watchlistIds.push(d3Watchlist.id);

        // Registered at the FRONT so it wins over the (b) search handler, which
        // matches every guest-search URL.
        handlers.unshift({
            matches: (u) => u.includes("seeMoreJobPostings/search") && u.includes("d3run"),
            respond: () => respond200(
                `<!doctype html><html><body><ul>
                    <li>
                        <a class="base-card__full-link" href="${d3SurvivorUrl}?refId=track-${tag}"><span class="sr-only">${d3SurvivorTitle}</span></a>
                        <h3 class="base-search-card__title">${d3SurvivorTitle}</h3>
                        <h4 class="base-search-card__subtitle">${D3_COMPANY}</h4>
                        <span class="job-search-card__location">Remote</span>
                    </li>
                </ul></body></html>`,
            ),
        });
        handlers.push({
            matches: (u) => u.startsWith(d3SurvivorUrl),
            respond: (u) => respond200(
                `<html><body><div class="top-card-layout">${d3SurvivorTitle}</div><div class="description__text">Live</div></body></html>`, u,
            ),
        });
        handlers.push({
            matches: (u) => u.startsWith(d3TargetUrl),
            respond: async (u) => {
                // THE CONCURRENT RUN. Lands after this run's candidate SELECT
                // (which read pendingClosedAt = NULL) and before its UPDATE.
                if (!d3StampWritten) {
                    d3StampWritten = true;
                    await prisma.jobPosting.updateMany({
                        where: { watchlistId: d3Watchlist.id, sourceUrl: d3TargetUrl },
                        data: { pendingClosedAt: d3ConcurrentStamp },
                    });
                }
                return respond200(
                    `<html><body><div class="top-card-layout">D3 Target</div><p>No longer accepting applications</p></body></html>`, u,
                );
            },
        });

        // Survivor: fetch-seen every tick, so it never goes stale. Pre-seeded
        // with the externalId the fetcher will compute, so nothing is created.
        await prisma.jobPosting.create({
            data: {
                watchlistId: d3Watchlist.id,
                externalId: externalIdFor(D3_COMPANY, d3SurvivorTitle, d3SurvivorUrl),
                company: D3_COMPANY,
                title: d3SurvivorTitle,
                sourceUrl: d3SurvivorUrl,
                status: "new",
                raw: "{}",
            },
        });
        // Target: an externalId no crawl can produce + 7h stale ⇒ the STALE
        // path's only candidate, and pendingClosedAt null ⇒ a first strike.
        const d3Target = await prisma.jobPosting.create({
            data: {
                watchlistId: d3Watchlist.id,
                externalId: `__D3_ABSENT__${randomBytes(8).toString("hex")}`,
                company: D3_COMPANY,
                title: "D3 Target Role",
                sourceUrl: d3TargetUrl,
                status: "new",
                lastSeenAt: new Date(Date.now() - 7 * 60 * 60 * 1000),
                pendingClosedAt: null,
                raw: "{}",
            },
        });

        const rD3 = await runWatchlist(d3Watchlist.id);
        if (rD3.error) fail(`(d) concurrent-stamp tick errored: ${rD3.error}`);
        else pass("(d) concurrent-stamp tick ran clean");
        if (d3StampWritten) pass("(d) the simulated concurrent run wrote its stamp inside the probe window");
        else fail("(d) the target was never probed — the concurrency window was never opened, assertions below are vacuous");

        const d3After = await prisma.jobPosting.findUniqueOrThrow({ where: { id: d3Target.id } });
        if (rD3.closed === 0) pass("(d) first strike closed nothing (closed=0)");
        else fail(`(d) expected closed=0 on a first strike, got ${rD3.closed}`);
        if (d3After.status === "new") pass("(d) target still status='new'");
        else fail(`(d) target status='${d3After.status}', expected 'new'`);
        if (d3After.pendingClosedAt?.getTime() === d3ConcurrentStamp.getTime()) {
            pass("(d) the concurrent run's stamp SURVIVED — the first-strike UPDATE matched nothing (no backdating, one stamp per pending episode)");
        } else {
            fail(`(d) the first strike overwrote a concurrent stamp: expected ${d3ConcurrentStamp.toISOString()}, got ${d3After.pendingClosedAt?.toISOString()} — the stamp was backdated and the OQ5a floor shortened`);
        }

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
