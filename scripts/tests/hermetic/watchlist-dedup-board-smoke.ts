/**
 * Hermetic smoke for the watchlist POST board-dedup guard.
 *
 *   DATABASE_URL="file:./dev.db" npx tsx scripts/tests/hermetic/watchlist-dedup-board-smoke.ts
 *
 * Regression for the "Apex / Apex Space" badge bug: the same greenhouse board
 * ("apex") was added twice under two display names, so NewPostingsCard rendered
 * two company badges for one board and the feed duplicated its rows. The POST
 * route now rejects a config whose watchlistConfigKey (kind + slug/tenant)
 * collides with an existing watchlist for the same user — regardless of the
 * display name the client picked.
 *
 * Asserts:
 *   - Same board (greenhouse slug X), different display name → 409 + existingId.
 *   - Slug case-insensitivity for greenhouse (X vs upper(X)) → 409.
 *   - Different board (different slug) → 200 (no false positive).
 *   - Same slug, different ATS kind (ashby vs greenhouse) → 200 (kind is part
 *     of the identity).
 *   - Keyword aggregators (linkedin) are NOT deduped — identical configs both
 *     succeed (watchlistConfigKey returns null for those).
 *
 * Mocks NextAuth via require.cache injection so no session round-trip happens,
 * and stubs scheduler/jobs/job-watcher.runWatchlist so the route's
 * fire-and-forget initial crawl never touches the network. Cleans up the
 * scratch user + its watchlists (cascade) in finally.
 */

import { PrismaClient } from '@prisma/client';
import { randomBytes } from 'crypto';

let passes = 0;
let fails = 0;
function pass(msg: string): void { console.log(`[PASS] ${msg}`); passes++; }
function fail(msg: string, detail?: unknown): void {
    console.error(`[FAIL] ${msg}`, detail ?? '');
    fails++;
}

let mockSessionUser: { id: string; email: string } | null = null;

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

injectCacheEntry('next-auth/next', {
    getServerSession: async () => {
        if (!mockSessionUser) return null;
        return { user: { id: mockSessionUser.id, email: mockSessionUser.email } };
    },
    default: () => undefined,
    unstable_getServerSession: async () => null,
});

// Stub the initial crawl so POST's fire-and-forget runWatchlist() never hits
// boards-api.greenhouse.io / LinkedIn. The route only imports `runWatchlist`
// from this module.
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
const userId = `wl-dedup-user-${tag}`;
const slug = `dedup-board-${tag}`;
const otherSlug = `other-board-${tag}`;

function buildPostRequest(body: unknown): Request {
    return new Request('http://test.invalid/api/watchlists', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

async function callPost(body: unknown): Promise<{ status: number; body: any }> {
    const res = await watchlistsRoute.POST(buildPostRequest(body));
    let json: unknown = null;
    try { json = await res.json(); } catch { /* noop */ }
    return { status: res.status, body: json };
}

async function main(): Promise<void> {
    try {
        await prisma.user.create({ data: { id: userId, email: `wl-dedup-${tag}@example.invalid` } });
        mockSessionUser = { id: userId, email: `wl-dedup-${tag}@example.invalid` };

        // ─── 1. First add of greenhouse board → 200 ──────────────────────
        let firstId = '';
        {
            const { status, body } = await callPost({
                name: 'Acme (canonical)',
                config: { kind: 'greenhouse', boardSlug: slug, companyName: 'Acme' },
            });
            if (status !== 200) fail(`first add: expected 200, got ${status}`, body);
            else pass('first add of greenhouse board → 200');
            firstId = body?.watchlist?.id ?? '';
            if (!firstId) fail('first add: response missing watchlist.id', body);
        }

        // ─── 2. Same board, different display name → 409 ─────────────────
        {
            const { status, body } = await callPost({
                name: 'Acme Space (duplicate name)',
                config: { kind: 'greenhouse', boardSlug: slug, companyName: 'Acme Space' },
            });
            if (status !== 409) fail(`dup add (diff name): expected 409, got ${status}`, body);
            else pass('same board + different display name → 409 (this is the Apex/Apex Space bug)');
            if (body?.existingId !== firstId) fail(`dup add: expected existingId=${firstId}, got ${body?.existingId}`);
            else pass('409 body points existingId at the original watchlist');
            if (typeof body?.error !== 'string' || !/already watched/i.test(body.error)) {
                fail('dup add: error message missing/unexpected', body?.error);
            } else {
                pass('409 carries a human-readable "already watched" message');
            }
        }

        // ─── 3. Same board, UPPERCASE slug → 409 (case-insensitive key) ──
        {
            const { status } = await callPost({
                name: 'Acme CAPS',
                config: { kind: 'greenhouse', boardSlug: slug.toUpperCase(), companyName: 'Acme' },
            });
            if (status !== 409) fail(`dup add (upper slug): expected 409, got ${status}`);
            else pass('same greenhouse board, upper-cased slug → 409 (key is case-folded)');
        }

        // ─── 4. Different greenhouse board → 200 (no false positive) ─────
        {
            const { status } = await callPost({
                name: 'Other Co',
                config: { kind: 'greenhouse', boardSlug: otherSlug, companyName: 'Other Co' },
            });
            if (status !== 200) fail(`different board: expected 200, got ${status}`);
            else pass('different greenhouse slug → 200 (not a false positive)');
        }

        // ─── 5. Same slug string, different ATS kind → 200 ───────────────
        // watchlistConfigKey prefixes the kind, so "greenhouse:<slug>" and
        // "ashby:<slug>" are distinct boards.
        {
            const { status } = await callPost({
                name: 'Acme on Ashby',
                config: { kind: 'ashby', boardSlug: slug, companyName: 'Acme' },
            });
            if (status !== 200) fail(`same slug diff kind: expected 200, got ${status}`);
            else pass('same slug under a different ATS kind → 200 (kind is part of identity)');
        }

        // ─── 6 + 7. LinkedIn keyword aggregators are never deduped ───────
        {
            const cfg = { kind: 'linkedin', keywords: 'software engineer', companyName: 'LinkedIn search' };
            const a = await callPost({ name: 'LI search', config: cfg });
            const b = await callPost({ name: 'LI search (again)', config: cfg });
            if (a.status !== 200 || b.status !== 200) {
                fail(`linkedin dup: expected both 200, got ${a.status}/${b.status}`, { a: a.body, b: b.body });
            } else {
                pass('identical linkedin keyword watchlists both → 200 (aggregators intentionally overlap)');
            }
        }

        // ─── Final DB shape: 1 + 1 + 1 + 2(linkedin) = 5 rows, no dups ───
        const rows = await prisma.watchlist.findMany({ where: { userId }, select: { kind: true } });
        if (rows.length !== 5) fail(`expected 5 watchlist rows after run, found ${rows.length}`, rows);
        else pass('exactly 5 watchlists persisted (2 dup attempts rejected, never written)');
    } finally {
        // Cascade-deletes any postings (none expected — runWatchlist stubbed).
        await prisma.watchlist.deleteMany({ where: { userId } }).catch(() => {});
        await prisma.user.delete({ where: { id: userId } }).catch(() => {});
        await prisma.$disconnect();
        console.log(`\n${passes}/${passes + fails} steps passed`);
        if (fails === 0) console.log('All checks passed.');
    }
    if (fails > 0) process.exit(1);
}

main().catch(e => {
    console.error('Unhandled error:', e);
    process.exit(2);
});
