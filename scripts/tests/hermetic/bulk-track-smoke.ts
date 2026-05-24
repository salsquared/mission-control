// Story S13.8 hermetic smoke for the bulk track-move repository helper.
// Run with: npx tsx scripts/tests/hermetic/bulk-track-smoke.ts
//
// Covers:
//   - happy path: N applications all move to the other track in one call
//   - cross-user ids in the input list silently drop (ownership scope)
//   - rows already on the target track are no-ops (don't count toward `updated`)
//   - same-employer-both-tracks conflict surfaces in `conflicts` (no partial move)
//   - rows with null normalizedCompany don't conflict against each other
//
// The repository helper runs inside a Prisma $transaction; this smoke exercises
// the public surface that POST /api/applications/bulk-track wraps.

import { prisma } from '@/lib/prisma';
import { bulkMoveApplicationsTrack } from '@/lib/repositories/applications';
import { normalizeCompanyName } from '@/lib/applications/normalize-company';

interface Step { name: string; ok: boolean; detail?: string }
const steps: Step[] = [];
function record(name: string, ok: boolean, detail?: string) {
    steps.push({ name, ok, detail });
    console.info(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
}

async function mkApp(userId: string, company: string, track: 'career' | 'side', extra: Partial<{ status: string }> = {}) {
    return prisma.application.create({
        data: {
            userId,
            company,
            normalizedCompany: normalizeCompanyName(company),
            role: 'Smoke role',
            status: extra.status ?? 'APPLIED',
            lastUpdateAt: new Date(),
            track,
        },
        select: { id: true, company: true, track: true, normalizedCompany: true },
    });
}

async function main() {
    const user = await prisma.user.findFirst({ select: { id: true } });
    if (!user) {
        console.error('No user in dev.db — log in to the app once before running.');
        process.exit(1);
    }
    const userId = user.id;

    const createdIds: string[] = [];
    try {
        // ─── 1. Happy path: move 3 career rows to side ────────────────────
        const tag = `BulkSmoke-${Date.now()}`;
        const a = await mkApp(userId, `${tag}-A`, 'career');
        const b = await mkApp(userId, `${tag}-B`, 'career');
        const c = await mkApp(userId, `${tag}-C`, 'career');
        createdIds.push(a.id, b.id, c.id);

        const result1 = await bulkMoveApplicationsTrack(userId, [a.id, b.id, c.id], 'side');
        record('happy path: updated count = 3', result1.updated === 3, `got ${result1.updated}`);
        record('happy path: no conflicts', result1.conflicts.length === 0);
        record('happy path: ids contains all three', [a.id, b.id, c.id].every(id => result1.ids.includes(id)));

        const after1 = await prisma.application.findMany({
            where: { id: { in: [a.id, b.id, c.id] } },
            select: { id: true, track: true },
        });
        record('happy path: all three rows now on side track', after1.every(r => r.track === 'side'));

        // ─── 2. Idempotent re-move: nothing changes ───────────────────────
        const result2 = await bulkMoveApplicationsTrack(userId, [a.id, b.id, c.id], 'side');
        record('re-move (already-target): updated = 0', result2.updated === 0);
        record('re-move (already-target): no conflicts', result2.conflicts.length === 0);

        // ─── 3. Cross-user ids silently drop ──────────────────────────────
        // Forge an id that doesn't belong to userId; the helper should treat it
        // as if it didn't exist.
        const result3 = await bulkMoveApplicationsTrack(userId, ['nonexistent-id-12345'], 'career');
        record('cross-user drop: updated = 0', result3.updated === 0);
        record('cross-user drop: no conflicts', result3.conflicts.length === 0);

        // ─── 4. Same-employer-both-tracks conflict ────────────────────────
        // Set up: same normalized company exists in both tracks; try to move
        // the career-side row to side — it should conflict with the existing
        // side-side row of the same normalized company.
        const conflictTag = `BulkSmokeConf-${Date.now()}`;
        const career = await mkApp(userId, `${conflictTag}-X`, 'career');
        const side = await mkApp(userId, `${conflictTag}-X`, 'side');
        createdIds.push(career.id, side.id);

        const result4 = await bulkMoveApplicationsTrack(userId, [career.id], 'side');
        record('conflict: updated = 0 (no partial)', result4.updated === 0);
        record('conflict: conflicts has 1 entry', result4.conflicts.length === 1);
        record('conflict: id field matches the moved row', result4.conflicts[0]?.id === career.id);
        record('conflict: existingId matches the blocker', result4.conflicts[0]?.existingId === side.id);

        // Verify nothing actually moved.
        const careerAfter = await prisma.application.findUnique({ where: { id: career.id }, select: { track: true } });
        record('conflict: original row untouched', careerAfter?.track === 'career');

        // ─── 5. Null normalizedCompany rows don't false-conflict ──────────
        // Two rows in different tracks both with null normalizedCompany.
        // SQLite allows multiple NULLs in the compound unique, so this should
        // pass without conflict.
        const nullA = await prisma.application.create({
            data: { userId, company: `${tag}-NullA`, normalizedCompany: null, role: 'r', status: 'APPLIED', lastUpdateAt: new Date(), track: 'career' },
            select: { id: true },
        });
        const nullB = await prisma.application.create({
            data: { userId, company: `${tag}-NullB`, normalizedCompany: null, role: 'r', status: 'APPLIED', lastUpdateAt: new Date(), track: 'side' },
            select: { id: true },
        });
        createdIds.push(nullA.id, nullB.id);
        const result5 = await bulkMoveApplicationsTrack(userId, [nullA.id], 'side');
        record('null normalizedCompany: no false conflict', result5.conflicts.length === 0);
        record('null normalizedCompany: row moved', result5.updated === 1);

        // ─── 6. Mixed batch (some moveable, some already-target) ──────────
        // After moving everything to side above, a-b-c are on side. Mix one
        // newly-created career row in with them and ask to move all to side.
        const fresh = await mkApp(userId, `${tag}-Fresh`, 'career');
        createdIds.push(fresh.id);
        const result6 = await bulkMoveApplicationsTrack(userId, [a.id, b.id, fresh.id], 'side');
        record('mixed batch: only the off-track row counts', result6.updated === 1);
        record('mixed batch: ids contains only the fresh one', result6.ids.length === 1 && result6.ids[0] === fresh.id);
    } finally {
        for (const id of createdIds) {
            try { await prisma.application.delete({ where: { id } }); } catch { /* ignore */ }
        }
        await prisma.$disconnect();
    }

    const passed = steps.filter(s => s.ok).length;
    const failed = steps.length - passed;
    console.info(`\n${passed}/${steps.length} steps passed`);
    if (failed > 0) {
        console.error(`${failed} step(s) failed`);
        process.exit(1);
    }
    console.info('All checks passed.');
}

main().catch((e) => { console.error(e); process.exit(1); });
