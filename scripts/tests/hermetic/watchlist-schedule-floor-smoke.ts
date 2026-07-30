/**
 * Hermetic smoke for the per-crew crawl-cadence FLOOR
 * (lib/watchlists/schedule-floor.ts — security fast-follow, 2026-07-29).
 *
 *   DATABASE_URL="file:./dev.db" npx tsx scripts/tests/hermetic/watchlist-schedule-floor-smoke.ts
 *
 * WHAT IT PROTECTS. `scheduler/jobs/job-watcher.ts:defaultLoadDue` honours a
 * watchlist's `scheduleMinutes` literally, and the Zod schema asked only for a
 * positive int — so a crew member could POST (or PATCH to) `scheduleMinutes: 1`
 * and take their CREW_WATCHLIST_LIMIT watchlists from ~30 crawls/day to ~7,200.
 * That spends the OWNER's Gemini key (the scheduler's `classifyEmploymentTypes`
 * sits outside the per-user AI credit cap), contends with the owner's Gmail
 * ingest classifier in the shared `acquireGeminiSlot()` line, and hammers
 * Greenhouse / Lever / LinkedIn from one residential IP. `lib/ai/quota.ts`
 * justifies leaving the scheduler unmetered by asserting the crawl cadence is
 * "the scheduler's and not theirs" — these assertions are what makes that true.
 *
 * Asserts:
 *   1. `crewMinScheduleMinutes()` env parsing: default / override / junk / clamp.
 *   2. Crew POST below the floor → 400 naming the floor; nothing written.
 *   3. Crew POST at the floor and with the schema default → 200.
 *   4. OWNER POST at 1 minute → 200, stored as 1. (The exemption must not
 *      regress: the owner debugs fetchers with fast cadences.)
 *   5. Crew PATCH below the floor → 400 and the STORED value is unchanged —
 *      the create-legal-then-edit-down bypass.
 *   6. Crew PATCH at the floor → 200; OWNER PATCH to 1 → 200.
 *   7. A crew PATCH that doesn't touch `scheduleMinutes` still succeeds (the
 *      floor must not become a tax on every other edit).
 *   8. The floor is re-read per request, so `pm2 restart … --update-env`
 *      applies without a code change.
 *
 * Genuinely hermetic: no network, no PM2, no live API. `runWatchlist` — POST's
 * fire-and-forget initial crawl — is stubbed via require.cache injection (the
 * pattern watchlist-crew-cap-smoke.ts / watchlist-dedup-board-smoke.ts
 * established for this route), so no job board is ever contacted. Fixtures are
 * two scratch users whose rows are deleted in the finally.
 */

import { PrismaClient } from '@prisma/client';
import { randomBytes } from 'crypto';
import { __seedViewer, __resetViewer } from '@/lib/viewer';
import {
    CREW_MIN_SCHEDULE_MINUTES_ENV,
    DEFAULT_CREW_MIN_SCHEDULE_MINUTES,
    crewMinScheduleMinutes,
    __resetScheduleFloorWarnLatch,
} from '@/lib/watchlists/schedule-floor';

let passes = 0;
let fails = 0;
function pass(msg: string): void { console.log(`[PASS] ${msg}`); passes++; }
function fail(msg: string, detail?: unknown): void {
    console.error(`[FAIL] ${msg}`, detail ?? '');
    fails++;
}

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
const watchlistRoute = require('@/app/api/watchlists/[id]/route') as {
    PATCH: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
};

const prisma = new PrismaClient();
const tag = randomBytes(4).toString('hex');
const crewId = `wl-floor-crew-${tag}`;
const ownerId = `wl-floor-owner-${tag}`;
const crewEmail = `wl-floor-crew-${tag}@example.invalid`;
const ownerEmail = `wl-floor-owner-${tag}@example.invalid`;

/** The floor this suite drives. 60 = the shipped default; asserted explicitly below. */
const FLOOR = DEFAULT_CREW_MIN_SCHEDULE_MINUTES;

interface CallResult { status: number; body: any }

async function callPost(
    name: string,
    boardSlug: string,
    scheduleMinutes?: number,
): Promise<CallResult> {
    const body: Record<string, unknown> = {
        name,
        config: { kind: 'greenhouse', boardSlug, companyName: name },
    };
    if (scheduleMinutes !== undefined) body.scheduleMinutes = scheduleMinutes;
    const res = await watchlistsRoute.POST(new Request('http://test.invalid/api/watchlists', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    }));
    let json: unknown = null;
    try { json = await res.json(); } catch { /* noop */ }
    return { status: res.status, body: json };
}

async function callPatch(id: string, patch: Record<string, unknown>): Promise<CallResult> {
    const res = await watchlistRoute.PATCH(
        new Request(`http://test.invalid/api/watchlists/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(patch),
        }),
        { params: Promise.resolve({ id }) },
    );
    let json: unknown = null;
    try { json = await res.json(); } catch { /* noop */ }
    return { status: res.status, body: json };
}

const countFor = (userId: string) => prisma.watchlist.count({ where: { userId } });
const storedCadence = async (id: string) =>
    (await prisma.watchlist.findUnique({ where: { id }, select: { scheduleMinutes: true } }))?.scheduleMinutes;

/** The 400 body must name the floor both machine-readably and in the prose. */
function assertFloorBody(label: string, body: any, requested: number): void {
    if (body?.reason !== 'schedule-floor') {
        fail(`${label}: body missing reason="schedule-floor"`, body);
        return;
    }
    if (body?.minScheduleMinutes !== FLOOR) {
        fail(`${label}: body minScheduleMinutes should be ${FLOOR}`, body);
        return;
    }
    if (body?.requested !== requested) {
        fail(`${label}: body requested should be ${requested}`, body);
        return;
    }
    if (typeof body?.error !== 'string' || !body.error.includes(String(FLOOR))) {
        fail(`${label}: error must be a human string containing the floor (api-client throws err.error)`, body?.error);
        return;
    }
    pass(`${label}: 400 body names the floor (minScheduleMinutes=${FLOOR}, requested=${requested}) in both forms`);
}

async function main(): Promise<void> {
    // The floor is read per request, so pin it explicitly rather than inheriting
    // whatever the shell has — and restore in the finally.
    const savedEnv = process.env[CREW_MIN_SCHEDULE_MINUTES_ENV];
    delete process.env[CREW_MIN_SCHEDULE_MINUTES_ENV];

    try {
        // ─── 1. Env parsing ────────────────────────────────────────────────
        {
            if (crewMinScheduleMinutes() !== FLOOR) {
                fail(`unset env should give the ${FLOOR}m default`, crewMinScheduleMinutes());
            } else pass(`unset ${CREW_MIN_SCHEDULE_MINUTES_ENV} → ${FLOOR}m default`);

            process.env[CREW_MIN_SCHEDULE_MINUTES_ENV] = '120';
            if (crewMinScheduleMinutes() !== 120) fail('env "120" should give 120', crewMinScheduleMinutes());
            else pass('env override honoured (120m)');

            process.env[CREW_MIN_SCHEDULE_MINUTES_ENV] = 'not-a-number';
            if (crewMinScheduleMinutes() !== FLOOR) {
                fail(`junk env should DEGRADE TO THE DEFAULT (${FLOOR}), never to "no floor"`, crewMinScheduleMinutes());
            } else pass('junk env degrades to the default, not to no-floor');

            process.env[CREW_MIN_SCHEDULE_MINUTES_ENV] = '0';
            if (crewMinScheduleMinutes() !== 1) fail('env "0" should clamp up to 1', crewMinScheduleMinutes());
            else pass('env "0" clamps to 1 (schema still demands a positive int)');

            process.env[CREW_MIN_SCHEDULE_MINUTES_ENV] = '999999';
            if (crewMinScheduleMinutes() !== 1440) fail('env above the cap should clamp to 1440', crewMinScheduleMinutes());
            else pass('env above the cap clamps to 1440 (one day)');

            delete process.env[CREW_MIN_SCHEDULE_MINUTES_ENV];
        }

        await prisma.user.create({ data: { id: crewId, email: crewEmail, role: 'crew' } });
        await prisma.user.create({ data: { id: ownerId, email: ownerEmail, role: 'owner' } });

        // Identity comes from the explicit __seedViewer seam (P1.2.4): the guards
        // resolve through lib/viewer.ts:resolveViewer(), whose next/headers read
        // THROWS for a handler invoked in-process from a tsx script. Cleared in
        // the finally so it cannot leak into the next suite.
        __seedViewer({ id: crewId, email: crewEmail, role: 'crew' });

        // ─── 2. Crew POST below the floor ──────────────────────────────────
        {
            const before = await countFor(crewId);
            const { status, body } = await callPost('Crew fast board', `floor-${tag}-fast`, 1);
            if (status !== 400) fail(`crew POST scheduleMinutes=1: expected 400, got ${status}`, body);
            else pass('crew POST scheduleMinutes=1 → 400 (floor enforced)');
            assertFloorBody('crew POST', body, 1);

            const after = await countFor(crewId);
            if (after !== before) fail(`rejected POST still wrote a row (${before} → ${after})`);
            else pass('rejected POST wrote nothing (row count unchanged)');
        }

        // Just under the line — the off-by-one that a `>` vs `>=` slip would let through.
        {
            const { status } = await callPost('Crew just-under', `floor-${tag}-under`, FLOOR - 1);
            if (status !== 400) fail(`crew POST scheduleMinutes=${FLOOR - 1}: expected 400, got ${status}`);
            else pass(`crew POST scheduleMinutes=${FLOOR - 1} (one under the floor) → 400`);
        }

        // ─── 3. Crew POST at/above the floor, and the schema default ───────
        let crewWatchlistId = '';
        {
            const { status, body } = await callPost('Crew at floor', `floor-${tag}-at`, FLOOR);
            if (status !== 200) fail(`crew POST scheduleMinutes=${FLOOR}: expected 200, got ${status}`, body);
            else {
                crewWatchlistId = body?.watchlist?.id ?? '';
                const stored = await storedCadence(crewWatchlistId);
                if (stored !== FLOOR) fail(`stored cadence should be ${FLOOR}, got ${stored}`);
                else pass(`crew POST exactly at the floor (${FLOOR}m) → 200, stored verbatim`);
            }
        }
        {
            const { status, body } = await callPost('Crew default', `floor-${tag}-default`);
            const stored = body?.watchlist?.id ? await storedCadence(body.watchlist.id) : undefined;
            if (status !== 200 || stored !== 240) {
                fail(`crew POST with no scheduleMinutes: expected 200 + the 240 default, got ${status}/${stored}`, body);
            } else pass('crew POST omitting scheduleMinutes → 200 with the 240m schema default (floor is not a tax on the normal path)');
        }

        // ─── 4. Owner exemption on POST ────────────────────────────────────
        let ownerWatchlistId = '';
        {
            __seedViewer({ id: ownerId, email: ownerEmail, role: 'owner' });
            const { status, body } = await callPost('Owner fast board', `floor-${tag}-owner`, 1);
            if (status !== 200) {
                fail(`owner POST scheduleMinutes=1: expected 200 (exempt), got ${status}`, body);
            } else {
                ownerWatchlistId = body?.watchlist?.id ?? '';
                const stored = await storedCadence(ownerWatchlistId);
                if (stored !== 1) fail(`owner cadence should persist as 1, got ${stored}`);
                else pass('OWNER POST scheduleMinutes=1 → 200, stored as 1 (exemption intact — they debug fetchers this way)');
            }
        }

        // ─── 5 + 6. PATCH: the create-legal-then-edit-down bypass ──────────
        {
            __seedViewer({ id: crewId, email: crewEmail, role: 'crew' });
            const { status, body } = await callPatch(crewWatchlistId, { scheduleMinutes: 1 });
            if (status !== 400) fail(`crew PATCH scheduleMinutes=1: expected 400, got ${status}`, body);
            else pass('crew PATCH scheduleMinutes=1 → 400 (the edit-down bypass is closed)');
            assertFloorBody('crew PATCH', body, 1);

            const stored = await storedCadence(crewWatchlistId);
            if (stored !== FLOOR) fail(`rejected PATCH still wrote (${FLOOR} → ${stored})`);
            else pass('rejected PATCH left the stored cadence untouched');
        }
        {
            const { status } = await callPatch(crewWatchlistId, { scheduleMinutes: FLOOR * 2 });
            const stored = await storedCadence(crewWatchlistId);
            if (status !== 200 || stored !== FLOOR * 2) {
                fail(`crew PATCH to ${FLOOR * 2}: expected 200 + persisted, got ${status}/${stored}`);
            } else pass(`crew PATCH to ${FLOOR * 2}m (above the floor) → 200, persisted`);
        }
        {
            // 7. An unrelated field must still patch cleanly.
            const { status } = await callPatch(crewWatchlistId, { name: 'Renamed by smoke' });
            const stored = await storedCadence(crewWatchlistId);
            if (status !== 200 || stored !== FLOOR * 2) {
                fail(`crew PATCH of an unrelated field: expected 200 with cadence intact, got ${status}/${stored}`);
            } else pass('crew PATCH that omits scheduleMinutes → 200 (floor no-ops on unrelated edits)');
        }
        {
            __seedViewer({ id: ownerId, email: ownerEmail, role: 'owner' });
            const { status } = await callPatch(ownerWatchlistId, { scheduleMinutes: 2 });
            const stored = await storedCadence(ownerWatchlistId);
            if (status !== 200 || stored !== 2) {
                fail(`owner PATCH to 2m: expected 200 + persisted, got ${status}/${stored}`);
            } else pass('OWNER PATCH to 2m → 200, persisted (exemption holds on PATCH too)');
        }

        // ─── 8. The floor is re-read per request ───────────────────────────
        {
            __seedViewer({ id: crewId, email: crewEmail, role: 'crew' });
            process.env[CREW_MIN_SCHEDULE_MINUTES_ENV] = '120';
            const raised = await callPost('Crew under raised floor', `floor-${tag}-raised`, 90);
            if (raised.status !== 400) fail(`with the floor raised to 120, a 90m create should 400, got ${raised.status}`, raised.body);
            else if (raised.body?.minScheduleMinutes !== 120) fail('raised-floor 400 should report minScheduleMinutes=120', raised.body);
            else pass('raising CREW_MIN_SCHEDULE_MINUTES takes effect on the NEXT request (read per call, no restart)');

            delete process.env[CREW_MIN_SCHEDULE_MINUTES_ENV];
            const relaxed = await callPost('Crew ok at default floor', `floor-${tag}-relaxed`, 90);
            if (relaxed.status !== 200) fail(`back at the ${FLOOR}m default, a 90m create should succeed, got ${relaxed.status}`, relaxed.body);
            else pass(`back at the ${FLOOR}m default the same 90m create → 200`);
        }
    } finally {
        // Clear the identity seam first — a seam left armed here would hand the
        // next suite in the pre-push gate this smoke's throwaway viewer.
        __resetViewer();
        __resetScheduleFloorWarnLatch();
        if (savedEnv === undefined) delete process.env[CREW_MIN_SCHEDULE_MINUTES_ENV];
        else process.env[CREW_MIN_SCHEDULE_MINUTES_ENV] = savedEnv;
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
