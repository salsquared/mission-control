/**
 * Hermetic smoke for the per-crew watchlist cap (docs/multi-user-crew.html
 * OQ10a / P2.6.1).
 *
 *   DATABASE_URL="file:./dev.db" npx tsx scripts/tests/hermetic/watchlist-crew-cap-smoke.ts
 *
 * The cap is what bounds risk R7: `defaultLoadDue` selects every active
 * watchlist with no ceiling (scheduler/jobs/job-watcher.ts:916-921), so an
 * unbounded crew watchlist count is unbounded scheduler work, unbounded
 * scraping from one residential IP, and unbounded Gemini spend on the OWNER's
 * key — the scheduler's `classifyEmploymentTypes` sits deliberately outside the
 * per-user AI credit cap (§2.9). Hence this is a load-bearing limit, not a UX
 * nicety, and it gets a regression test.
 *
 * Asserts:
 *   1. Crew may create up to the limit → 200 each.
 *   2. The create that would exceed it → 400, and the body NAMES the limit
 *      (`limit`, `current`, `reason: "watchlist-limit"`, and the number inside
 *      the human `error` string, which is what lib/api-client.ts surfaces).
 *   3. Nothing is written on rejection — the row count does not move.
 *   4. The cap is checked BEFORE the board-dedup scan: a crew member at the
 *      limit re-posting an already-watched board gets 400, not 409.
 *   5. The OWNER is exempt — they blow past the same limit with 200s.
 *   6. THE RACE: two simultaneous POSTs into the single remaining slot resolve
 *      to exactly one 200 and one 400, and exactly `limit` rows exist
 *      afterwards. This is the assertion that fails if the in-transaction
 *      re-check is ever dropped back to a bare count-then-create.
 *
 * Genuinely hermetic: no network, no PM2, no live API. `runWatchlist` — POST's
 * fire-and-forget initial crawl — is stubbed via require.cache injection (the
 * pattern watchlist-dedup-board-smoke.ts established for this same route), so
 * no job board is ever contacted. Fixtures are two scratch users whose rows
 * cascade-delete in the finally.
 */

import { PrismaClient } from '@prisma/client';
import { randomBytes } from 'crypto';
import { __seedViewer, __resetViewer } from '@/lib/viewer';

let passes = 0;
let fails = 0;
function pass(msg: string): void { console.log(`[PASS] ${msg}`); passes++; }
function fail(msg: string, detail?: unknown): void {
    console.error(`[FAIL] ${msg}`, detail ?? '');
    fails++;
}

// Pin the cap LOW before the route module loads — it reads the env var once at
// module scope (same convention as GEMINI_RATE_PER_MIN / ARXIV_RATE_PER_MIN),
// so this assignment must precede the require() below. 3 keeps the fixture
// small while still exercising the boundary.
const LIMIT = 3;
process.env.CREW_WATCHLIST_LIMIT = String(LIMIT);

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

// Stub the initial crawl so POST's fire-and-forget runWatchlist() never hits a
// real job board. The route only imports `runWatchlist` from this module.
injectCacheEntry('@/scheduler/jobs/job-watcher', {
    runWatchlist: async (watchlistId: string) => ({
        watchlistId, newPostings: 0, seenAgain: 0, closed: 0, refreshedAlive: 0, error: null,
    }),
});

const watchlistsRoute = require('@/app/api/watchlists/route') as {
    POST: (req: Request) => Promise<Response>;
};

const prisma = new PrismaClient();
const tag = randomBytes(4).toString('hex');
const crewId = `wl-cap-crew-${tag}`;
const ownerId = `wl-cap-owner-${tag}`;
const crewEmail = `wl-cap-crew-${tag}@example.invalid`;
const ownerEmail = `wl-cap-owner-${tag}@example.invalid`;

interface PostResult { status: number; body: any }

async function callPost(name: string, boardSlug: string): Promise<PostResult> {
    const res = await watchlistsRoute.POST(new Request('http://test.invalid/api/watchlists', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            name,
            config: { kind: 'greenhouse', boardSlug, companyName: name },
        }),
    }));
    let json: unknown = null;
    try { json = await res.json(); } catch { /* noop */ }
    return { status: res.status, body: json };
}

const countFor = (userId: string) => prisma.watchlist.count({ where: { userId } });

async function main(): Promise<void> {
    try {
        await prisma.user.create({ data: { id: crewId, email: crewEmail, role: 'crew' } });
        await prisma.user.create({ data: { id: ownerId, email: ownerEmail, role: 'owner' } });

        // Identity comes from the explicit __seedViewer seam (P1.2.4): the
        // guards resolve through lib/viewer.ts:resolveViewer(), whose
        // next/headers read THROWS for a handler invoked in-process from a tsx
        // script. Cleared in the finally so it cannot leak into the next suite.
        __seedViewer({ id: crewId, email: crewEmail, role: 'crew' });

        // ─── 1. Crew fills the allowance ────────────────────────────────────
        let filled = true;
        for (let i = 1; i <= LIMIT; i++) {
            const { status, body } = await callPost(`Crew board ${i}`, `crew-${tag}-${i}`);
            if (status !== 200) { fail(`crew create ${i}/${LIMIT}: expected 200, got ${status}`, body); filled = false; }
        }
        if (filled) pass(`crew creates ${LIMIT} watchlists → 200 each (under the cap)`);

        // ─── 2 + 3. The one over the line ───────────────────────────────────
        {
            const before = await countFor(crewId);
            const { status, body } = await callPost('Crew board over', `crew-${tag}-over`);
            if (status !== 400) {
                fail(`crew create ${LIMIT + 1}: expected 400, got ${status}`, body);
            } else pass(`crew create ${LIMIT + 1} → 400 (cap enforced)`);

            if (body?.reason !== 'watchlist-limit') fail('400 body missing reason="watchlist-limit"', body);
            else if (body?.limit !== LIMIT) fail(`400 body limit should be ${LIMIT}`, body);
            else if (body?.current !== LIMIT) fail(`400 body current should be ${LIMIT}`, body);
            else pass(`400 body names the limit machine-readably (limit=${LIMIT}, current=${LIMIT})`);

            if (typeof body?.error !== 'string' || !body.error.includes(String(LIMIT))) {
                fail('400 error must be a human string containing the limit (api-client throws err.error)', body?.error);
            } else pass('400 error string states the limit plainly, not a generic failure');

            const after = await countFor(crewId);
            if (after !== before) fail(`rejected create still wrote a row (${before} → ${after})`);
            else pass('rejected create wrote nothing (row count unchanged)');
        }

        // ─── 4. Cap is checked ahead of the board-dedup scan ────────────────
        {
            // `crew-<tag>-1` is already watched, so a passing cap would 409 here.
            const { status, body } = await callPost('Crew board 1 again', `crew-${tag}-1`);
            if (status !== 400) fail(`at-limit duplicate board: expected 400 (cap first), got ${status}`, body);
            else pass('at-limit duplicate board → 400, not 409 (cap precedes dedup)');
        }

        // ─── 5. Owner exemption ─────────────────────────────────────────────
        {
            __seedViewer({ id: ownerId, email: ownerEmail, role: 'owner' });
            let ok = true;
            for (let i = 1; i <= LIMIT + 2; i++) {
                const { status, body } = await callPost(`Owner board ${i}`, `owner-${tag}-${i}`);
                if (status !== 200) { fail(`owner create ${i}: expected 200, got ${status}`, body); ok = false; }
            }
            const owned = await countFor(ownerId);
            if (ok && owned === LIMIT + 2) pass(`owner is exempt — ${LIMIT + 2} watchlists, all 200`);
            else if (ok) fail(`owner should hold ${LIMIT + 2} watchlists, found ${owned}`);
        }

        // ─── 6. The concurrent-create race ──────────────────────────────────
        {
            // Fresh crew fixture holding LIMIT-1 rows, so exactly ONE slot is
            // left for two simultaneous POSTs to fight over.
            const raceId = `wl-cap-race-${tag}`;
            const raceEmail = `wl-cap-race-${tag}@example.invalid`;
            await prisma.user.create({ data: { id: raceId, email: raceEmail, role: 'crew' } });
            __seedViewer({ id: raceId, email: raceEmail, role: 'crew' });
            try {
                for (let i = 1; i < LIMIT; i++) {
                    await callPost(`Race seed ${i}`, `race-${tag}-seed-${i}`);
                }

                const [a, b] = await Promise.all([
                    callPost('Race A', `race-${tag}-a`),
                    callPost('Race B', `race-${tag}-b`),
                ]);
                const statuses = [a.status, b.status].sort((x, y) => x - y);
                const rows = await countFor(raceId);

                if (statuses[0] !== 200 || statuses[1] !== 400) {
                    fail(`simultaneous creates into the last slot: expected [200, 400], got [${statuses}]`, { a, b });
                } else pass('two simultaneous creates into the last slot → exactly one 200, one 400');

                if (rows !== LIMIT) fail(`race left ${rows} rows, cap is ${LIMIT} (the boundary leaked)`);
                else pass(`race left exactly ${LIMIT} rows — the in-transaction re-check held`);

                const loser = a.status === 400 ? a : b;
                if (loser.body?.reason !== 'watchlist-limit') {
                    fail('race loser must get the same watchlist-limit 400, not a 500', loser.body);
                } else pass('race loser gets the cap 400, not an Internal Server Error');
            } finally {
                await prisma.watchlist.deleteMany({ where: { userId: raceId } }).catch(() => {});
                await prisma.user.delete({ where: { id: raceId } }).catch(() => {});
            }
        }
    } finally {
        // Clear the identity seam first — a seam left armed here would hand the
        // next suite in the pre-push gate this smoke's throwaway viewer.
        __resetViewer();
        for (const id of [crewId, ownerId]) {
            await prisma.watchlist.deleteMany({ where: { userId: id } }).catch(() => {});
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
