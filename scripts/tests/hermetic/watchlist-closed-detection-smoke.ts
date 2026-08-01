/**
 * Hermetic port of the closed-posting-detection assertions that used to live in
 * `scripts/tests/integration/watchlist-phase2-smoke.ts` §4 (design doc P5.1.3.2,
 * docs/multi-user-crew.html).
 *
 *   DATABASE_URL="file:./dev.db" npx tsx scripts/tests/hermetic/watchlist-closed-detection-smoke.ts
 *
 * WHY THE ASSERTIONS MOVED. The integration version staged a close exactly the
 * way this file does — backdate one posting's `lastSeenAt` by 7h and mutate its
 * `externalId` so the next crawl can't return it — then re-ran the watchlist
 * over HTTP against the live PM2 dev server and asserted `closed >= 1`,
 * `status === "closed"`, `removedAt` set. Since 2026-05-25 close detection is
 * PROBE-GATED (docs/archive/close-detection-probe.md): absence from the fetch
 * only nominates a candidate; the row flips solely on a live GET of its
 * `sourceUrl` returning positive evidence of removal. Against a real Lever
 * board that verdict is whatever the internet says that minute — "alive" for a
 * posting still up (scenario B below), "unknown" on a timeout (scenario C) —
 * so the assertion was never deterministic, and the integration suite is not in
 * the pre-push gate, so nothing caught it. `MC_LIVENESS_BYPASS` pins the
 * verdict, which makes the assertions deterministic, which makes them
 * gate-able. Same test-only override the liveness-probe,
 * job-watcher-scale-regression and c3-cursor smokes already use; production
 * never sets it (and P3.1c makes a production tier ignore it outright).
 *
 * Asserts — the three assertions carried over from §4 are marked ▸:
 *
 *   (A) `MC_LIVENESS_BYPASS=closed`, careers-page watchlist, one row absent
 *       from the crawl and 7h stale. Tick 1 stamps `pendingClosedAt` only
 *       (OQ5a two-tick confirmation, 2026-06-12 — the reason the integration
 *       file's single re-run could not have been right against current code);
 *       tick 2 confirms: ▸ `RunResult.closed === 1`, ▸ `status === "closed"`,
 *       ▸ `removedAt` set. Plus the precision half the integration file never
 *       checked: the fetch-seen sibling row is untouched, nothing is created,
 *       and ZERO probe GETs are issued (the bypass short-circuits `probeBatch`
 *       — no network is load-bearing anywhere in this path).
 *
 *   (B) `MC_LIVENESS_BYPASS=alive` on the identical staging → 0 closed,
 *       `refreshedAlive === 1`, `lastSeenAt` re-armed, `pendingClosedAt`
 *       cleared. This is the probe outcome that made the ported assertion flap:
 *       a posting still live on the source never closes, however stale.
 *
 *   (C) `MC_LIVENESS_BYPASS=unknown` on the identical staging → 0 closed, 0
 *       refreshed, row byte-for-byte untouched (`pendingClosedAt` preserved,
 *       `lastSeenAt` not bumped) — absence of evidence neither confirms nor
 *       clears.
 *
 * Hermetic: `globalThis.fetch` is stubbed and THROWS on an unstubbed URL, so a
 * probe that somehow escaped the bypass fails loudly instead of reaching the
 * network; no PM2, no session, no external API, no LLM (rows are pre-seeded, so
 * the create branch — and its employment-type classifier — never runs).
 * Throwaway user + watchlists + postings under a random tag (concurrent-safe);
 * full cleanup in `finally`. The scratch user owns no `GlobalSetting` row, so
 * `findGlobalSettingForUser` returns null and no negative filter can perturb
 * the crawl — nothing shared is read or mutated.
 */
import { unlinkSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { createHash, randomBytes } from "crypto";

// The crawl (and any probe) records its outcome to the fetcher-health store;
// point it at a throwaway file so fixture hosts never land in the real
// data/fetcher-health.db. The store reads this lazily at init, so setting it
// here — after the hoisted imports, before main() — is early enough.
const TMP_HEALTH_DB = `/tmp/watchlist-closed-detection-smoke-health-${process.pid}-${Date.now()}.db`;
process.env.FETCHER_HEALTH_PATH = TMP_HEALTH_DB;
// P3.1c: bypassVerdict() IGNORES MC_LIVENESS_BYPASS on a production tier. If
// the invoking shell exports either var, every verdict below would fall through
// to a REAL probe — non-hermetic and non-deterministic. Pin both.
delete process.env.MC_SCHEDULER_TIER;
if (process.env.NODE_ENV === "production") {
    // Next's globals type NODE_ENV as read-only; the cast is the only way to
    // pin it from a script, and pinning it is what keeps this suite hermetic.
    (process.env as Record<string, string | undefined>).NODE_ENV = "development";
}
// A confirmed close dispatches a closure-summary notification; keep Gmail out
// of it even if the caller's env says otherwise (parity with pre-push.sh).
process.env.EMAIL_ENABLED = "0";

import { runWatchlist } from "@/scheduler/jobs/job-watcher";

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
        // Only the careers listing is stubbed. A posting-URL GET reaching here
        // means a liveness probe ran despite the bypass — fail loud, never fall
        // through to the network.
        throw new Error(`unstubbed fetch: ${url}`);
    }) as typeof fetch;
}

function respond200(body: string): Response {
    return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
}

/** Count fetches to posting detail URLs (i.e. liveness probes) since log index `from`. */
function probeFetchesSince(from: number): number {
    return fetchLog.slice(from).filter(u => u.includes("/careers/jobs/")).length;
}

// ─── staging ───────────────────────────────────────────────────────────────

const SEVEN_HOURS_MS = 7 * 60 * 60 * 1000;

interface Staged {
    watchlistId: string;
    /** Row the crawl still returns — fetch-seen, therefore never a close candidate. */
    survivorId: string;
    /** Row the crawl no longer returns AND 7h stale — the only close candidate. */
    targetId: string;
    /** The 7h-old lastSeenAt the target was staged with. */
    staleSeenAt: Date;
}

/**
 * Reproduces the integration file's §4 staging on a throwaway watchlist:
 * one posting still listed by the source, one backdated 7h with an externalId
 * the crawl cannot return. `pendingClosedAt` pre-stamps a prior tick's first
 * strike (scenarios B and C need a row mid-confirmation to prove alive clears
 * the stamp and unknown preserves it).
 */
async function stageWatchlist(
    userId: string,
    tag: string,
    label: string,
    opts: { pendingClosedAt?: Date } = {},
): Promise<Staged> {
    const company = `Closed-Detect ${label} Co`;
    const root = `https://closed-detect-${label}-${tag}.example.invalid/careers/`;

    // Survivor: the crawl returns exactly this one link every tick, which keeps
    // the fetch non-empty — close-detection SKIPS a run whose fetch came back
    // empty or partial (SAFETY 1/2 in job-watcher), so a lone target would
    // never be probed at all.
    const survivorTitle = "Facilities Technician";
    const survivorUrl = `${root}jobs/survivor`;
    handlers.push({
        matches: (u) => u === root,
        respond: () => respond200(
            `<!doctype html><html><body><a href="/careers/jobs/survivor">${survivorTitle}</a></body></html>`,
        ),
    });

    const watchlist = await prisma.watchlist.create({
        data: {
            userId,
            name: `closed-detection ${label} ${tag}`,
            kind: "careers-page",
            config: JSON.stringify({
                kind: "careers-page",
                rootUrl: root,
                linkPattern: "/careers/jobs/",
                companyName: company,
            }),
            scheduleMinutes: 60,
            // Non-null lastSuccessAt ⇒ NOT a first run, so close-detection is
            // armed (SAFETY 3) and the inline employment-type classifier — the
            // one LLM call on this path — stays off.
            lastRunAt: new Date(Date.now() - 60 * 60 * 1000),
            lastSuccessAt: new Date(Date.now() - 60 * 60 * 1000),
        },
    });

    const survivor = await prisma.jobPosting.create({
        data: {
            watchlistId: watchlist.id,
            externalId: externalIdFor(company, survivorTitle, survivorUrl),
            company,
            title: survivorTitle,
            sourceUrl: survivorUrl,
            status: "new",
            raw: "{}",
        },
    });

    const staleSeenAt = new Date(Date.now() - SEVEN_HOURS_MS);
    const target = await prisma.jobPosting.create({
        data: {
            watchlistId: watchlist.id,
            // The `__SMOKE_DELETED__` shape is carried over verbatim from the
            // integration file: an externalId no crawl can produce, so the row
            // is permanently absent from `seenExternalIds`.
            externalId: `__SMOKE_DELETED__${randomBytes(8).toString("hex")}`,
            company,
            title: "Overnight Security Officer",
            // Deliberately NOT served by the fetch stub — a probe of this URL
            // throws, so an escaped bypass can never be mistaken for a verdict.
            sourceUrl: `${root}jobs/target-${tag}`,
            status: "new",
            lastSeenAt: staleSeenAt,
            pendingClosedAt: opts.pendingClosedAt ?? null,
            raw: "{}",
        },
    });

    return { watchlistId: watchlist.id, survivorId: survivor.id, targetId: target.id, staleSeenAt };
}

// ─── main ──────────────────────────────────────────────────────────────────

async function main() {
    const tag = randomBytes(4).toString("hex");
    const userId = `closed-detection-smoke-${tag}`;
    const watchlistIds: string[] = [];

    installFetchStub();

    try {
        await prisma.user.create({ data: { id: userId, email: `closed-detection-${tag}@example.invalid` } });

        // ════ (A) closed verdict — the ported §4 assertions ═══════════════
        process.env.MC_LIVENESS_BYPASS = "closed";
        const a = await stageWatchlist(userId, tag, "closed", {});
        watchlistIds.push(a.watchlistId);

        // ── tick 1: first strike, pending only ──
        const markA1 = fetchLog.length;
        const r1 = await runWatchlist(a.watchlistId);
        if (r1.error) fail(`(A) tick 1 errored: ${r1.error}`);
        else pass("(A) tick 1 ran clean");
        if (r1.newPostings === 0 && r1.seenAgain === 1) {
            pass("(A) tick 1: crawl re-saw the survivor and created nothing (staging matches the fetcher's externalId)");
        } else {
            fail(`(A) tick 1: expected newPostings=0 seenAgain=1, got newPostings=${r1.newPostings} seenAgain=${r1.seenAgain} — fixture drift would make the close assertions vacuous`);
        }
        if (probeFetchesSince(markA1) === 0) {
            pass("(A) tick 1: zero probe GETs — MC_LIVENESS_BYPASS short-circuited probeBatch (no network evidence involved)");
        } else {
            fail(`(A) tick 1: ${probeFetchesSince(markA1)} probe GET(s) issued — the bypass did not take effect`);
        }
        if (r1.closed === 0) pass("(A) OQ5a tick 1: RunResult.closed === 0 — a first closed verdict only stamps pending");
        else fail(`(A) OQ5a tick 1: expected closed=0, got ${r1.closed}`);

        const target1 = await prisma.jobPosting.findUniqueOrThrow({ where: { id: a.targetId } });
        if (target1.status === "new") pass("(A) OQ5a tick 1: target still status='new' (no one-tick flip)");
        else fail(`(A) OQ5a tick 1: target status='${target1.status}', expected 'new'`);
        if (target1.pendingClosedAt != null) pass("(A) OQ5a tick 1: target pendingClosedAt stamped");
        else fail("(A) OQ5a tick 1: target pendingClosedAt not stamped");
        if (target1.removedAt == null) pass("(A) OQ5a tick 1: target removedAt still null on the first strike");
        else fail(`(A) OQ5a tick 1: removedAt set on the first strike (${target1.removedAt?.toISOString()})`);

        // ── tick 2: second consecutive closed verdict confirms ──
        const markA2 = fetchLog.length;
        const r2 = await runWatchlist(a.watchlistId);
        if (r2.error) fail(`(A) tick 2 errored: ${r2.error}`);
        else pass("(A) tick 2 ran clean");
        if (probeFetchesSince(markA2) === 0) pass("(A) tick 2: zero probe GETs (bypass still short-circuiting)");
        else fail(`(A) tick 2: ${probeFetchesSince(markA2)} probe GET(s) issued`);

        // ▸ ported: `body.closed < 1` → fail
        if (r2.closed === 1) pass("▸ (A) closed-detection: RunResult.closed === 1 on the confirming re-run");
        else fail(`▸ (A) closed-detection: expected closed=1, got ${r2.closed}`);

        const target2 = await prisma.jobPosting.findUniqueOrThrow({ where: { id: a.targetId } });
        // ▸ ported: `after?.status !== "closed"` → fail
        if (target2.status === "closed") pass("▸ (A) closed-detection: target posting is status='closed'");
        else fail(`▸ (A) closed-detection: target status='${target2.status}', expected 'closed'`);
        // ▸ ported: `!after?.removedAt` → fail
        if (target2.removedAt != null) pass("▸ (A) closed-detection: removedAt set");
        else fail("▸ (A) closed-detection: removedAt not set");
        if (target2.pendingClosedAt == null) pass("(A) OQ5a tick 2: pendingClosedAt cleared on the confirmed flip");
        else fail(`(A) OQ5a tick 2: pendingClosedAt still set (${target2.pendingClosedAt?.toISOString()})`);

        const survivorA = await prisma.jobPosting.findUniqueOrThrow({ where: { id: a.survivorId } });
        if (survivorA.status === "new" && survivorA.removedAt == null && survivorA.pendingClosedAt == null) {
            pass("(A) precision: the fetch-seen sibling was never nominated — status='new', no removedAt, no pending stamp");
        } else {
            fail(`(A) precision: fetch-seen sibling perturbed — status='${survivorA.status}' removedAt=${survivorA.removedAt} pendingClosedAt=${survivorA.pendingClosedAt}`);
        }

        // ════ (B) alive verdict — why the live-probe assertion flapped ════
        // Identical staging, plus a prior tick's first strike already recorded.
        process.env.MC_LIVENESS_BYPASS = "alive";
        const firstStrikeAt = new Date(Date.now() - 60 * 60 * 1000);
        const b = await stageWatchlist(userId, tag, "alive", { pendingClosedAt: firstStrikeAt });
        watchlistIds.push(b.watchlistId);

        const rB = await runWatchlist(b.watchlistId);
        if (rB.error) fail(`(B) run errored: ${rB.error}`);
        else pass("(B) run ran clean");
        if (rB.closed === 0) pass("(B) alive verdict: 0 closed — a stale, absent-from-crawl posting that is still live never flips");
        else fail(`(B) alive verdict: expected closed=0, got ${rB.closed}`);
        if (rB.refreshedAlive === 1) pass("(B) alive verdict: refreshedAlive === 1 (the row was re-armed, not closed)");
        else fail(`(B) alive verdict: expected refreshedAlive=1, got ${rB.refreshedAlive}`);

        const targetB = await prisma.jobPosting.findUniqueOrThrow({ where: { id: b.targetId } });
        if (targetB.status === "new") pass("(B) alive verdict: target stays status='new'");
        else fail(`(B) alive verdict: target status='${targetB.status}', expected 'new'`);
        if (targetB.lastSeenAt.getTime() > b.staleSeenAt.getTime()) {
            pass("(B) alive verdict: lastSeenAt bumped forward — the 6h staleness clock is re-armed");
        } else {
            fail(`(B) alive verdict: lastSeenAt not bumped (${targetB.lastSeenAt.toISOString()})`);
        }
        if (targetB.pendingClosedAt == null) pass("(B) OQ5a: explicit alive evidence CLEARS a prior first strike");
        else fail(`(B) OQ5a: pendingClosedAt survived an alive verdict (${targetB.pendingClosedAt?.toISOString()})`);

        // ════ (C) unknown verdict — ambiguity leaves the row alone ════════
        process.env.MC_LIVENESS_BYPASS = "unknown";
        const c = await stageWatchlist(userId, tag, "unknown", { pendingClosedAt: firstStrikeAt });
        watchlistIds.push(c.watchlistId);

        const rC = await runWatchlist(c.watchlistId);
        if (rC.error) fail(`(C) run errored: ${rC.error}`);
        else pass("(C) run ran clean");
        if (rC.closed === 0 && rC.refreshedAlive === 0) {
            pass("(C) unknown verdict: 0 closed, 0 refreshed — no verdict, no write");
        } else {
            fail(`(C) unknown verdict: expected closed=0 refreshedAlive=0, got closed=${rC.closed} refreshedAlive=${rC.refreshedAlive}`);
        }

        const targetC = await prisma.jobPosting.findUniqueOrThrow({ where: { id: c.targetId } });
        if (targetC.status === "new") pass("(C) unknown verdict: target stays status='new'");
        else fail(`(C) unknown verdict: target status='${targetC.status}', expected 'new'`);
        if (targetC.pendingClosedAt?.getTime() === firstStrikeAt.getTime()) {
            pass("(C) OQ5a: unknown PRESERVES the prior first strike untouched (absence of evidence neither confirms nor clears)");
        } else {
            fail(`(C) OQ5a: pendingClosedAt changed under an unknown verdict: ${targetC.pendingClosedAt?.toISOString()}`);
        }
        if (targetC.lastSeenAt.getTime() === c.staleSeenAt.getTime()) {
            pass("(C) unknown verdict: lastSeenAt untouched (staleness clock NOT re-armed — the row is re-probed next tick)");
        } else {
            fail(`(C) unknown verdict: lastSeenAt moved to ${targetC.lastSeenAt.toISOString()}`);
        }
    } finally {
        delete process.env.MC_LIVENESS_BYPASS;
        // Closure-summary notification from (A) tick 2, plus any strays.
        await prisma.notification.deleteMany({ where: { userId } }).catch(() => undefined);
        for (const id of watchlistIds) {
            await prisma.jobPosting.deleteMany({ where: { watchlistId: id } }).catch(() => undefined);
            await prisma.watchlist.delete({ where: { id } }).catch(() => undefined);
        }
        await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
        await prisma.$disconnect();
        globalThis.fetch = originalFetch;
        await cleanupTempHealthDb();
        console.log(`\n${passes}/${passes + fails} steps passed`);
        if (fails === 0) console.log("All checks passed.");
    }
    if (fails > 0) process.exit(1);
}

async function cleanupTempHealthDb() {
    try {
        const health = await import("@/lib/fetcher-health/store");
        await health._resetFetcherHealthForTests(); // close before unlinking
    } catch { /* store may never have initialized */ }
    for (const suffix of ["", "-wal", "-shm"]) {
        try { unlinkSync(`${TMP_HEALTH_DB}${suffix}`); } catch { /* may not exist */ }
    }
}

main().catch(async (e) => {
    await cleanupTempHealthDb();
    console.error("Unhandled error:", e);
    process.exit(2);
});
