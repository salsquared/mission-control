/**
 * Hermetic smoke for the AI credit on the INITIAL CRAWL of a watchlist create
 * (security fast-follow, 2026-08-02).
 *
 *   DATABASE_URL="file:./dev.db" npx tsx scripts/tests/hermetic/watchlist-create-quota-smoke.ts
 *
 * WHAT IT PROTECTS. `POST /api/watchlists` fire-and-forgets `runWatchlist(row.id)`
 * so a new watchlist yields postings in seconds instead of on the next scheduler
 * tick. `runWatchlist` classifies every newly-ingested posting's employment type
 * through Gemini, on the OWNER's key — and the route is `requireSession()`, so
 * CREW reach it. Until this fix the call took no credit: a crew member could
 * create (and delete, under CREW_WATCHLIST_LIMIT) watchlists in a loop and spend
 * unmetered LLM budget once per create, which is exactly the runaway shape
 * lib/ai/quota.ts exists to bound. The sibling `[id]/run` route had metered the
 * identical call since P2.5.2; this one not doing so was an oversight.
 *
 * THE UX DECISION THIS PINS. Over quota, the row is STILL CREATED and only the
 * crawl is skipped — the expensive half is refused, the cheap half is not, and
 * the scheduler crawls the row on its normal cadence anyway. So this route is
 * the ONE quota-wired route that does not answer a denial with the shared 429
 * (ai-quota-smoke.ts's `refusal` field is where that exception is declared and
 * count-pinned). The 200 stays honest via `initialCrawl` — asserted below,
 * because a 200 that silently did less than it says is the failure mode a
 * "create anyway" policy invites.
 *
 * Asserts:
 *   1. Under quota: 200, `initialCrawl.started === true`, runWatchlist ran once,
 *      and the AiUsage counter moved by exactly one.
 *   2. OVER quota: still 200 and the row still exists, but runWatchlist did NOT
 *      run and `initialCrawl` reports { started:false, reason:"ai-quota",
 *      used, limit }. This is the assertion that fails without the fix — before
 *      it, the crawl fired regardless of the counter.
 *   3. The OWNER is exempt at CREW_AI_DAILY_LIMIT=0: 200, crawl started, and
 *      ZERO AiUsage rows written (the exempt path must not touch the table).
 *   4. A REJECTED create costs nothing: a cadence-floor 400 and a duplicate-board
 *      409 each leave the counter untouched and never call runWatchlist. This is
 *      the ordering half of CLAUDE.md's placement rule — `consumeAiCredit`
 *      mutates, so a credit taken before those rejections would bill a crew
 *      member for a crawl that never happened.
 *
 * Genuinely hermetic: no network, no PM2, no Gemini. `runWatchlist` is replaced
 * with a COUNTING stub via require.cache injection (the pattern
 * watchlist-crew-cap-smoke.ts established for this route), so no job board is
 * contacted and "did the crawl fire" is directly observable. Fixtures are
 * scratch users whose rows are deleted in the finally.
 */

import { PrismaClient } from '@prisma/client';
import { randomBytes } from 'crypto';
import { __seedViewer, __resetViewer } from '@/lib/viewer';
import { WatchlistMutationResponseSchema } from '@/lib/schemas/watchlists';

let passes = 0;
let fails = 0;
function pass(msg: string): void { console.log(`[PASS] ${msg}`); passes++; }
function fail(msg: string, detail?: unknown): void {
    console.error(`[FAIL] ${msg}`, detail ?? '');
    fails++;
}

// A break-glass loopback escape inherited from the shell would resolve an OWNER
// viewer, and the owner is quota-exempt — every "crawl skipped" assertion here
// would silently become a passing-shaped 200. Same guard as ai-quota-smoke.ts.
delete process.env.MC_DEV_LOOPBACK_OWNER;
delete process.env.MC_PROD_LOOPBACK_OWNER;

const cache = (require as unknown as { cache: Record<string, unknown> }).cache;

function injectCacheEntry(specifier: string, exports: Record<string, unknown>): void {
    const resolved = require.resolve(specifier);
    cache[resolved] = {
        id: resolved,
        filename: resolved,
        loaded: true,
        children: [],
        paths: [],
        exports,
    };
}

/**
 * Every watchlist id the (stubbed) initial crawl was fired for. The whole point
 * of the fix is that this array stops growing when the caller is over quota, so
 * it is the primary observable rather than a proxy for one.
 */
const crawled: string[] = [];

injectCacheEntry('@/scheduler/jobs/job-watcher', {
    runWatchlist: async (watchlistId: string) => {
        crawled.push(watchlistId);
        return { watchlistId, newPostings: 0, seenAgain: 0, closed: 0, refreshedAlive: 0, error: null };
    },
});

const watchlistsRoute = require('@/app/api/watchlists/route') as {
    POST: (req: Request) => Promise<Response>;
};

const prisma = new PrismaClient();
const tag = randomBytes(4).toString('hex');
const crewId = `wl-quota-crew-${tag}`;
const ownerId = `wl-quota-owner-${tag}`;
const crewEmail = `wl-quota-crew-${tag}@example.invalid`;
const ownerEmail = `wl-quota-owner-${tag}@example.invalid`;

interface CallResult { status: number; body: any }

async function callPost(
    name: string,
    boardSlug: string,
    extra: Record<string, unknown> = {},
): Promise<CallResult> {
    const res = await watchlistsRoute.POST(new Request('http://test.invalid/api/watchlists', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            name,
            config: { kind: 'greenhouse', boardSlug, companyName: name },
            ...extra,
        }),
    }));
    let json: unknown = null;
    try { json = await res.json(); } catch { /* noop */ }
    return { status: res.status, body: json };
}

/**
 * The fire-and-forget crawl is not awaited by the handler, so a microtask turn
 * has to elapse before `crawled` is authoritative. Without this the "did NOT
 * crawl" assertion would pass for the wrong reason — timing, not the gate.
 */
const settle = () => new Promise<void>(r => setTimeout(r, 25));

async function usageCount(userId: string): Promise<number> {
    const { utcDateBucket } = await import('@/lib/notifications/dispatch');
    const row = await prisma.aiUsage.findUnique({
        where: { userId_day: { userId, day: utcDateBucket() } },
        select: { count: true },
    });
    return row?.count ?? 0;
}

async function main(): Promise<void> {
    const savedLimit = process.env.CREW_AI_DAILY_LIMIT;

    try {
        await prisma.user.create({ data: { id: crewId, email: crewEmail, role: 'crew' } });
        await prisma.user.create({ data: { id: ownerId, email: ownerEmail, role: 'owner' } });

        // Identity comes from the explicit __seedViewer seam (P1.2.4): the guards
        // resolve through lib/viewer.ts:resolveViewer(), whose next/headers read
        // THROWS for a handler invoked in-process from a tsx script.
        __seedViewer({ id: crewId, email: crewEmail, role: 'crew' });

        // One credit for the whole day: the first create crawls, the second must not.
        process.env.CREW_AI_DAILY_LIMIT = '1';

        // ─── 1. Under quota: the crawl fires and costs exactly one credit ───
        {
            const before = await usageCount(crewId);
            const { status, body } = await callPost('Crew first', `quota-${tag}-1`);
            await settle();

            if (status !== 200) {
                fail(`crew create under quota: expected 200, got ${status}`, body);
            } else if (body?.initialCrawl?.started !== true) {
                fail('under quota the 200 must report initialCrawl.started === true', body?.initialCrawl);
            } else if (crawled.length !== 1 || crawled[0] !== body?.watchlist?.id) {
                fail('under quota the initial crawl must fire for exactly the created row', crawled);
            } else if ((await usageCount(crewId)) !== before + 1) {
                fail(`the create should consume exactly one credit (${before} → ${await usageCount(crewId)})`);
            } else {
                pass('crew create under quota → 200, initialCrawl.started=true, crawl fired once, +1 credit');
            }
        }

        // ─── 2. Over quota: row created, crawl skipped, 200 says so ─────────
        // The load-bearing assertion. Before the fix `runWatchlist` was called
        // unconditionally, so `crawled.length` reached 2 here.
        {
            const usedBefore = await usageCount(crewId);
            const crawlsBefore = crawled.length;
            const { status, body } = await callPost('Crew second', `quota-${tag}-2`);
            await settle();

            const id = body?.watchlist?.id;
            const stored = id ? await prisma.watchlist.findUnique({ where: { id }, select: { id: true } }) : null;

            if (status !== 200) {
                fail(`crew create OVER quota should still 200 (the row is cheap), got ${status}`, body);
            } else if (!stored) {
                fail('crew create over quota must still persist the watchlist row', body);
            } else if (crawled.length !== crawlsBefore) {
                fail(
                    `OVER QUOTA THE INITIAL CRAWL STILL RAN — this is the unmetered-Gemini bug. ` +
                    `crawled ${crawlsBefore} → ${crawled.length}`,
                    crawled,
                );
            } else if (body?.initialCrawl?.started !== false) {
                fail('over quota the 200 must report initialCrawl.started === false, not stay silent', body?.initialCrawl);
            } else if (body.initialCrawl.reason !== 'ai-quota') {
                fail('the skipped-crawl report must name the reason "ai-quota"', body.initialCrawl);
            } else if (body.initialCrawl.used !== usedBefore || body.initialCrawl.limit !== 1) {
                fail(`the skipped-crawl report should carry { used: ${usedBefore}, limit: 1 }`, body.initialCrawl);
            } else if ((await usageCount(crewId)) !== usedBefore) {
                fail(`a refused credit must not increment the counter (${usedBefore} → ${await usageCount(crewId)})`);
            } else {
                pass('crew create OVER quota → 200 + row created, crawl SKIPPED, initialCrawl reports { started:false, reason:"ai-quota" }');
            }
        }

        // ─── 3. Owner exemption, at the harshest limit ──────────────────────
        {
            process.env.CREW_AI_DAILY_LIMIT = '0';
            __seedViewer({ id: ownerId, email: ownerEmail, role: 'owner' });
            const crawlsBefore = crawled.length;
            const { status, body } = await callPost('Owner board', `quota-${tag}-owner`);
            await settle();

            const ownerRows = await prisma.aiUsage.count({ where: { userId: ownerId } });
            if (status !== 200 || body?.initialCrawl?.started !== true) {
                fail('owner create at CREW_AI_DAILY_LIMIT=0 must 200 with the crawl started (exempt)', { status, body });
            } else if (crawled.length !== crawlsBefore + 1) {
                fail('the owner\'s initial crawl must still fire — the crew cap exists to protect their spend', crawled);
            } else if (ownerRows !== 0) {
                fail(`the exempt path must not touch AiUsage (owner wrote ${ownerRows} row(s))`);
            } else {
                pass('OWNER create at CREW_AI_DAILY_LIMIT=0 → 200, crawl fired, zero AiUsage rows (exemption intact)');
            }
        }

        // ─── 4. A rejected create costs no credit and no crawl ──────────────
        // CLAUDE.md's placement rule, stated behaviourally: consumeAiCredit
        // MUTATES, so it must sit after every rejection the handler can make.
        {
            process.env.CREW_AI_DAILY_LIMIT = '20';
            __seedViewer({ id: crewId, email: crewEmail, role: 'crew' });
            const usedBefore = await usageCount(crewId);
            const crawlsBefore = crawled.length;

            // (a) below the per-crew cadence floor → 400 from schedule-floor.ts
            const floor = await callPost('Crew too fast', `quota-${tag}-fast`, { scheduleMinutes: 1 });
            // (b) a board this user already watches → 409 from the dedup scan
            const dupe = await callPost('Crew duplicate', `quota-${tag}-1`);
            await settle();

            if (floor.status !== 400) {
                fail(`expected the cadence-floor 400 to still fire, got ${floor.status}`, floor.body);
            } else if (dupe.status !== 409) {
                fail(`expected the duplicate-board 409 to still fire, got ${dupe.status}`, dupe.body);
            } else if ((await usageCount(crewId)) !== usedBefore) {
                fail(
                    `a rejected create burned a credit (${usedBefore} → ${await usageCount(crewId)}) — ` +
                    `the consume is placed BEFORE a rejection it must follow`,
                );
            } else if (crawled.length !== crawlsBefore) {
                fail('a rejected create still fired the initial crawl', crawled);
            } else {
                pass('rejected creates (cadence-floor 400, duplicate-board 409) burn no credit and fire no crawl');
            }
        }

        // ─── 5. Both 200 shapes satisfy the declared wire contract ──────────
        // `lib/api-client.ts` parses every watchlist mutation through
        // WatchlistMutationResponseSchema, and Zod STRIPS unknown keys rather
        // than erroring — so a route/schema drift on `initialCrawl` would not
        // surface as a failure anywhere, it would just silently vanish from the
        // typed client. Parsing the real bodies here is what catches that.
        {
            // §1 already spent this user's single credit for the UTC day, so
            // clear the counter to get one of each shape rather than two refusals.
            await prisma.aiUsage.deleteMany({ where: { userId: crewId } });
            process.env.CREW_AI_DAILY_LIMIT = '1';
            const granted = await callPost('Contract granted', `quota-${tag}-c1`);
            const refused = await callPost('Contract refused', `quota-${tag}-c2`);
            await settle();

            const g = WatchlistMutationResponseSchema.safeParse(granted.body);
            const r = WatchlistMutationResponseSchema.safeParse(refused.body);
            if (!g.success) {
                fail('the granted 200 body does not satisfy WatchlistMutationResponseSchema', g.error.issues);
            } else if (!r.success) {
                fail('the refused 200 body does not satisfy WatchlistMutationResponseSchema', r.error.issues);
            } else if (g.data.initialCrawl?.started !== true || r.data.initialCrawl?.started !== false) {
                fail('initialCrawl survived the schema parse with the wrong value', {
                    granted: g.data.initialCrawl, refused: r.data.initialCrawl,
                });
            } else {
                pass('both 200 shapes round-trip through WatchlistMutationResponseSchema with initialCrawl intact');
            }
        }
    } finally {
        // Clear the identity seam first — a seam left armed here would hand the
        // next suite in the pre-push gate this smoke's throwaway viewer.
        __resetViewer();
        if (savedLimit === undefined) delete process.env.CREW_AI_DAILY_LIMIT;
        else process.env.CREW_AI_DAILY_LIMIT = savedLimit;
        for (const id of [crewId, ownerId]) {
            await prisma.watchlist.deleteMany({ where: { userId: id } }).catch(() => {});
            await prisma.aiUsage.deleteMany({ where: { userId: id } }).catch(() => {});
            await prisma.user.delete({ where: { id } }).catch(() => {});
        }
        await prisma.$disconnect();
    }
}

/**
 * The exit path lives OUT here, not at the bottom of `main()`, so no early
 * `return` inside the body can skip it (the resume-list-smoke bug: printed
 * [FAIL] and still exited 0, so the pre-push gate passed a red suite).
 */
function finish(): never {
    console.log(`\n${passes}/${passes + fails} steps passed`);
    if (fails > 0) process.exit(1);
    console.log('All checks passed.');
    process.exit(0);
}

main().then(finish, e => {
    console.error('Unhandled error:', e);
    process.exit(2);
});
