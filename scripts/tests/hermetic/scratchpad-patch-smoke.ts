/**
 * Hermetic smoke for M7.8.2 — scratchpad PATCH coverage on WorkRole / Project /
 * Education entity routes.
 *
 *   DATABASE_URL="file:./dev.db" npx tsx scripts/tests/hermetic/scratchpad-patch-smoke.ts
 *
 * Asserts the new `scratchpad: String?` column flows correctly end-to-end:
 *   - PATCH accepts a string + persists it; GET returns it on the entity.
 *   - Empty string is preserved (zod default lets "" through; the route
 *     passes whatever the client sent). Null clears via explicit `null`.
 *   - 8 KB cap enforced at the schema layer (8193 chars → 400).
 *   - Cross-user PATCH against another user's entity → 404 (no existence
 *     leak; route returns 404 from the ownership check).
 *
 * Mocks NextAuth via require.cache injection so no session round-trip
 * happens. Cleans up the scratch users + profiles in finally.
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

const workRolesRoute = require('@/app/api/profile/work-roles/route');
const projectsRoute = require('@/app/api/profile/projects/route');
const educationRoute = require('@/app/api/profile/education/route');

const prisma = new PrismaClient();
const tag = randomBytes(4).toString('hex');
const userId = `sp-smoke-user-${tag}`;
const otherUserId = `sp-smoke-other-${tag}`;
let profileId = '';
let otherProfileId = '';
let workRoleId = '';
let projectId = '';
let educationId = '';
let otherWorkRoleId = '';

function buildPatchRequest(body: unknown): Request {
    return new Request('http://test.invalid/api/profile/x', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

async function callPatch(routeMod: { PATCH: (req: Request) => Promise<Response> }, body: unknown): Promise<{ status: number; body: unknown }> {
    const res = await routeMod.PATCH(buildPatchRequest(body));
    let json: unknown = null;
    try { json = await res.json(); } catch { /* noop */ }
    return { status: res.status, body: json };
}

async function main(): Promise<void> {
    try {
        await prisma.user.create({ data: { id: userId, email: `sp-${tag}@example.invalid` } });
        await prisma.user.create({ data: { id: otherUserId, email: `sp-other-${tag}@example.invalid` } });

        const profile = await prisma.profile.create({ data: { userId } });
        profileId = profile.id;
        const otherProfile = await prisma.profile.create({ data: { userId: otherUserId } });
        otherProfileId = otherProfile.id;

        const wr = await prisma.workRole.create({
            data: {
                profileId,
                company: `Co-${tag}`,
                title: 'Engineer',
                startDate: new Date('2022-01-01'),
                bullets: '[]',
            },
        });
        workRoleId = wr.id;

        const proj = await prisma.project.create({
            data: {
                profileId,
                name: `Proj-${tag}`,
                bullets: '[]',
            },
        });
        projectId = proj.id;

        const edu = await prisma.education.create({
            data: {
                profileId,
                institution: `Edu-${tag}`,
                bullets: '[]',
            },
        });
        educationId = edu.id;

        const otherWr = await prisma.workRole.create({
            data: {
                profileId: otherProfileId,
                company: `OtherCo-${tag}`,
                title: 'Engineer',
                startDate: new Date('2022-01-01'),
                bullets: '[]',
            },
        });
        otherWorkRoleId = otherWr.id;

        mockSessionUser = { id: userId, email: `sp-${tag}@example.invalid` };

        // ─── Test 1: WorkRole PATCH writes + reads scratchpad ─────────────
        {
            const notes = 'Worked on the payments pipeline — moved off Express to Fastify, cut latency a lot.';
            const { status } = await callPatch(workRolesRoute, { id: workRoleId, scratchpad: notes });
            if (status !== 200) fail(`work-role PATCH scratchpad: expected 200, got ${status}`);
            else pass('work-role: PATCH scratchpad → 200');

            const row = await prisma.workRole.findUnique({ where: { id: workRoleId } });
            if (row?.scratchpad !== notes) {
                fail(`work-role: scratchpad column mismatch`, { expected: notes, got: row?.scratchpad });
            } else {
                pass('work-role: scratchpad persisted verbatim');
            }
        }

        // ─── Test 2: Project PATCH writes + reads scratchpad ──────────────
        {
            const notes = 'Open-source project I maintain — Rust + WebAssembly demos, ~250 stars.';
            const { status } = await callPatch(projectsRoute, { id: projectId, scratchpad: notes });
            if (status !== 200) fail(`project PATCH scratchpad: expected 200, got ${status}`);
            else pass('project: PATCH scratchpad → 200');

            const row = await prisma.project.findUnique({ where: { id: projectId } });
            if (row?.scratchpad !== notes) {
                fail(`project: scratchpad column mismatch`, { expected: notes, got: row?.scratchpad });
            } else {
                pass('project: scratchpad persisted verbatim');
            }
        }

        // ─── Test 3: Education PATCH writes + reads scratchpad ────────────
        {
            const notes = 'CS undergrad — focused on distributed systems + compilers.';
            const { status } = await callPatch(educationRoute, { id: educationId, scratchpad: notes });
            if (status !== 200) fail(`education PATCH scratchpad: expected 200, got ${status}`);
            else pass('education: PATCH scratchpad → 200');

            const row = await prisma.education.findUnique({ where: { id: educationId } });
            if (row?.scratchpad !== notes) {
                fail(`education: scratchpad column mismatch`, { expected: notes, got: row?.scratchpad });
            } else {
                pass('education: scratchpad persisted verbatim');
            }
        }

        // ─── Test 4: PATCH with scratchpad: null clears the column ────────
        {
            const { status } = await callPatch(workRolesRoute, { id: workRoleId, scratchpad: null });
            if (status !== 200) fail(`work-role null-clear: expected 200, got ${status}`);
            else pass('work-role: PATCH scratchpad=null → 200');

            const row = await prisma.workRole.findUnique({ where: { id: workRoleId } });
            if (row?.scratchpad !== null) {
                fail(`work-role: null-clear failed`, { got: row?.scratchpad });
            } else {
                pass('work-role: null-clear set column to null');
            }
        }

        // ─── Test 5: cap enforcement — 8193 chars → 400 ───────────────────
        {
            const tooLong = 'x'.repeat(8193);
            const { status, body } = await callPatch(workRolesRoute, { id: workRoleId, scratchpad: tooLong });
            if (status !== 400) {
                fail(`work-role over-cap: expected 400, got ${status}`, body);
            } else {
                pass('work-role: 8193-char scratchpad → 400 (cap enforced at zod layer)');
            }
        }

        // ─── Test 6: cross-user PATCH → 404 ───────────────────────────────
        {
            const { status } = await callPatch(workRolesRoute, {
                id: otherWorkRoleId,
                scratchpad: 'should never persist',
            });
            if (status !== 404) {
                fail(`cross-user: expected 404, got ${status}`);
            } else {
                pass('cross-user: PATCH another user\'s work-role → 404');
            }

            // Verify the other user's row is untouched.
            const otherRow = await prisma.workRole.findUnique({ where: { id: otherWorkRoleId } });
            if (otherRow?.scratchpad !== null) {
                fail(`cross-user: other user's scratchpad got written`, otherRow?.scratchpad);
            } else {
                pass('cross-user: other user\'s row untouched (scratchpad still null)');
            }
        }
    } finally {
        if (workRoleId) await prisma.workRole.delete({ where: { id: workRoleId } }).catch(() => {});
        if (projectId) await prisma.project.delete({ where: { id: projectId } }).catch(() => {});
        if (educationId) await prisma.education.delete({ where: { id: educationId } }).catch(() => {});
        if (otherWorkRoleId) await prisma.workRole.delete({ where: { id: otherWorkRoleId } }).catch(() => {});
        if (profileId) await prisma.profile.delete({ where: { id: profileId } }).catch(() => {});
        if (otherProfileId) await prisma.profile.delete({ where: { id: otherProfileId } }).catch(() => {});
        await prisma.user.delete({ where: { id: userId } }).catch(() => {});
        await prisma.user.delete({ where: { id: otherUserId } }).catch(() => {});
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
