// Story S7.6 hermetic smoke. Exercises createProfileSnapshot, listProfileSnapshots,
// getProfileSnapshot, deleteProfileSnapshot end-to-end against dev.db.
// Run with: npx tsx scripts/tests/hermetic/profile-snapshots-smoke.ts

import { prisma } from '@/lib/prisma';
import {
    createProfileSnapshot,
    listProfileSnapshots,
    getProfileSnapshot,
    deleteProfileSnapshot,
} from '@/lib/repositories/profile-snapshots';
import { findOrCreateProfile } from '@/lib/repositories/profile';

interface Step { name: string; ok: boolean; detail?: string }
const steps: Step[] = [];
function record(name: string, ok: boolean, detail?: string) {
    steps.push({ name, ok, detail });
    console.info(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
}

async function main() {
    const user = await prisma.user.findFirst({ select: { id: true, email: true } });
    if (!user) {
        console.error('No user in dev.db — log in to the app once before running.');
        process.exit(1);
    }
    console.info(`Using user ${user.email} (${user.id})`);

    // Track the snapshots we create so a mid-test failure still cleans up.
    const createdIds: string[] = [];

    try {
        // 1. Make sure the user has a profile to snapshot.
        const profile = await findOrCreateProfile(user.id);
        record('findOrCreateProfile: produces a profile', typeof profile.id === 'string' && profile.id.length > 0);

        // 2. Create a labeled snapshot.
        const labeled = await createProfileSnapshot(user.id, 'smoke-labeled');
        createdIds.push(labeled.id);
        record('createProfileSnapshot (labeled): row id present', typeof labeled.id === 'string' && labeled.id.length > 0);
        record('createProfileSnapshot (labeled): label written', labeled.label === 'smoke-labeled');
        record('createProfileSnapshot (labeled): takenAt is a Date', labeled.takenAt instanceof Date);

        // 3. Create an unlabeled snapshot.
        const unlabeled = await createProfileSnapshot(user.id, null);
        createdIds.push(unlabeled.id);
        record('createProfileSnapshot (null label): label is null', unlabeled.label === null);

        // 4. List snapshots — newest first, both of ours present.
        const list = await listProfileSnapshots(user.id);
        const idx0 = list.findIndex((s) => s.id === unlabeled.id);
        const idx1 = list.findIndex((s) => s.id === labeled.id);
        record('listProfileSnapshots: both snapshots present', idx0 >= 0 && idx1 >= 0);
        record(
            'listProfileSnapshots: ordered newest first',
            idx0 >= 0 && idx1 >= 0 && idx0 < idx1,
            `idx[unlabeled]=${idx0} idx[labeled]=${idx1}`,
        );
        record(
            'listProfileSnapshots: summary excludes payload',
            !('payload' in (list[0] as unknown as Record<string, unknown>)),
        );

        // 5. Get full snapshot — payload round-trips through JSON.
        const full = await getProfileSnapshot(user.id, labeled.id);
        record('getProfileSnapshot: returns a row', full !== null);
        record(
            'getProfileSnapshot: payload has nested shape',
            full !== null
                && Array.isArray(full.payload.workRoles)
                && Array.isArray(full.payload.projects)
                && Array.isArray(full.payload.education),
        );
        record(
            'getProfileSnapshot: payload profile id matches current',
            full !== null && full.payload.id === profile.id,
        );

        // 6. Cross-user ownership — a different userId should not see the snapshot.
        const stranger = await getProfileSnapshot('nonexistent-user-id', labeled.id);
        record('getProfileSnapshot: rejects wrong userId', stranger === null);

        // 7. Delete one — returns true; the second delete returns false.
        const deleted = await deleteProfileSnapshot(user.id, unlabeled.id);
        record('deleteProfileSnapshot: returns true on first delete', deleted === true);
        const deletedAgain = await deleteProfileSnapshot(user.id, unlabeled.id);
        record('deleteProfileSnapshot: idempotent (false for unknown id)', deletedAgain === false);

        // 8. Cross-user delete — should not affect the labeled snapshot.
        const strangerDelete = await deleteProfileSnapshot('nonexistent-user-id', labeled.id);
        record('deleteProfileSnapshot: rejects wrong userId', strangerDelete === false);
        const stillThere = await getProfileSnapshot(user.id, labeled.id);
        record('deleteProfileSnapshot: cross-user delete left row intact', stillThere !== null);

        // 9. Corrupt-payload defense — hand-write a bad row, expect null (not a throw).
        const bad = await prisma.profileSnapshot.create({
            data: { userId: user.id, payload: 'not-json{' },
            select: { id: true },
        });
        createdIds.push(bad.id);
        const badRead = await getProfileSnapshot(user.id, bad.id);
        record('getProfileSnapshot: corrupt payload returns null (no throw)', badRead === null);
    } finally {
        // Cleanup — best-effort, don't fail the run on a stray.
        for (const id of createdIds) {
            try { await prisma.profileSnapshot.delete({ where: { id } }); } catch { /* ignore */ }
        }
        await prisma.$disconnect();
    }

    const passed = steps.filter((s) => s.ok).length;
    const failed = steps.length - passed;
    console.info(`\n${passed}/${steps.length} steps passed`);
    if (failed > 0) {
        console.error(`${failed} step(s) failed`);
        process.exit(1);
    }
    console.info('All checks passed.');
}

main().catch((e) => { console.error(e); process.exit(1); });
