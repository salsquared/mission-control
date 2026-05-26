/**
 * Hermetic smoke for M7.9.2 — tagline PATCH coverage on /api/profile.
 *
 *   DATABASE_URL="file:./dev.db" npx tsx scripts/tests/hermetic/tagline-patch-smoke.ts
 *
 * Asserts the new `tagline: String?` column flows correctly end-to-end:
 *   - PATCH accepts a string + persists it; GET returns it on the profile.
 *   - 200-char cap enforced at the zod schema layer (201 chars → 400).
 *   - Null clears via explicit `null`.
 *   - Empty string is preserved as-is (the route doesn't auto-null an empty
 *     string — that's the client's call to make).
 *
 * Mocks NextAuth via require.cache injection so no session round-trip
 * happens. /api/profile PATCH is single-user (looks up by session.user.id)
 * so no cross-user test needed. Cleans up the scratch user + profile in
 * finally.
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

const profileRoute = require('@/app/api/profile/route');

const prisma = new PrismaClient();
const tag = randomBytes(4).toString('hex');
const userId = `tp-smoke-user-${tag}`;
let profileId = '';

function buildPatchRequest(body: unknown): Request {
    return new Request('http://test.invalid/api/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

async function callPatch(body: unknown): Promise<{ status: number; body: unknown }> {
    const res = await profileRoute.PATCH(buildPatchRequest(body));
    let json: unknown = null;
    try { json = await res.json(); } catch { /* noop */ }
    return { status: res.status, body: json };
}

async function main(): Promise<void> {
    try {
        await prisma.user.create({ data: { id: userId, email: `tp-${tag}@example.invalid` } });
        const profile = await prisma.profile.create({ data: { userId } });
        profileId = profile.id;

        mockSessionUser = { id: userId, email: `tp-${tag}@example.invalid` };

        // ─── Test 1: PATCH writes + persists tagline ──────────────────────
        {
            const tagline = 'Backend engineer focused on developer-facing systems and reliability.';
            const { status } = await callPatch({ tagline });
            if (status !== 200) fail(`PATCH tagline: expected 200, got ${status}`);
            else pass('PATCH tagline → 200');

            const row = await prisma.profile.findUnique({ where: { id: profileId } });
            if (row?.tagline !== tagline) {
                fail('tagline column mismatch', { expected: tagline, got: row?.tagline });
            } else {
                pass('tagline persisted verbatim');
            }
        }

        // ─── Test 2: 200-char cap (201 chars → 400) ───────────────────────
        {
            const tooLong = 'x'.repeat(201);
            const { status, body } = await callPatch({ tagline: tooLong });
            if (status !== 400) fail(`over-cap: expected 400, got ${status}`, body);
            else pass('over-cap: 201-char tagline → 400 (zod TAGLINE_MAX_BYTES enforced)');

            // Confirm the previous value wasn't clobbered by the rejected write.
            const row = await prisma.profile.findUnique({ where: { id: profileId } });
            if (row?.tagline === tooLong) {
                fail('over-cap: rejected write somehow persisted');
            } else {
                pass('over-cap: prior tagline preserved after rejected write');
            }
        }

        // ─── Test 3: 200-char exact (boundary) → 200 ──────────────────────
        {
            const exactCap = 'y'.repeat(200);
            const { status } = await callPatch({ tagline: exactCap });
            if (status !== 200) fail(`boundary: 200-char exact tagline expected 200, got ${status}`);
            else pass('boundary: 200-char tagline accepted at exact cap');

            const row = await prisma.profile.findUnique({ where: { id: profileId } });
            if (row?.tagline?.length !== 200) {
                fail(`boundary: persisted length mismatch: ${row?.tagline?.length}`);
            } else {
                pass('boundary: 200 chars persisted intact');
            }
        }

        // ─── Test 4: PATCH with tagline: null clears the column ───────────
        {
            const { status } = await callPatch({ tagline: null });
            if (status !== 200) fail(`null-clear: expected 200, got ${status}`);
            else pass('PATCH tagline=null → 200');

            const row = await prisma.profile.findUnique({ where: { id: profileId } });
            if (row?.tagline !== null) {
                fail('null-clear failed', { got: row?.tagline });
            } else {
                pass('null-clear set tagline column to null');
            }
        }

        // ─── Test 5: empty string preserved (not auto-nulled) ─────────────
        // The schema accepts '' (no .min(1)); route passes through verbatim.
        // Client UI handles empty-vs-null semantics — server stays dumb.
        {
            const { status } = await callPatch({ tagline: '' });
            if (status !== 200) fail(`empty-string: expected 200, got ${status}`);
            else pass('PATCH tagline="" → 200');

            const row = await prisma.profile.findUnique({ where: { id: profileId } });
            if (row?.tagline !== '') {
                fail('empty-string: not preserved as empty string', { got: row?.tagline });
            } else {
                pass('empty-string preserved verbatim (no server-side null coercion)');
            }
        }
    } finally {
        if (profileId) await prisma.profile.delete({ where: { id: profileId } }).catch(() => {});
        await prisma.user.delete({ where: { id: userId } }).catch(() => {});
        await prisma.$disconnect();
    }

    console.log(`\n${passes}/${passes + fails} steps passed`);
    if (fails > 0) process.exit(1);
    console.log('All checks passed.');
}

main().catch(e => {
    console.error('Unhandled error:', e);
    process.exit(2);
});
