// Exercises the profile repository end-to-end against dev.db. Verifies M7.2.
// Run with: npx tsx scripts/tests/profile-repo-smoke.ts
//
// On success: creates and tears down a workRole / project / education each;
// prints a tabular pass/fail summary. On failure: shows which step blew up.

import { prisma } from '@/lib/prisma';
import {
    findOrCreateProfile,
    updateProfileHeader,
    createWorkRole,
    updateWorkRole,
    deleteWorkRole,
    createProject,
    updateProject,
    deleteProject,
    createEducation,
    updateEducation,
    deleteEducation,
} from '@/lib/repositories/profile';
import { parseBullets } from '@/lib/profile/bullets';

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

    // 1. findOrCreate is idempotent + returns nested empty arrays.
    const p1 = await findOrCreateProfile(user.id);
    record('findOrCreateProfile: returns hydrated tree', Array.isArray(p1.workRoles) && Array.isArray(p1.projects) && Array.isArray(p1.education));
    const p2 = await findOrCreateProfile(user.id);
    record('findOrCreateProfile: idempotent (same id)', p1.id === p2.id);

    // 2. Header PATCH round-trip.
    const before = p1.headline;
    const sentinel = `smoke-${Date.now()}`;
    const updated = await updateProfileHeader(user.id, { headline: sentinel, summary: 'smoke summary', links: [{ label: 'gh', url: 'https://github.com/x' }] });
    record('updateProfileHeader: writes headline', updated.headline === sentinel);
    record('updateProfileHeader: writes links array', Array.isArray(updated.links) && updated.links?.[0]?.label === 'gh');
    await updateProfileHeader(user.id, { headline: before, summary: null, links: null });
    const restored = await findOrCreateProfile(user.id);
    record('updateProfileHeader: restored', restored.headline === before && restored.links === null);

    // 3. WorkRole CRUD.
    const wr = await createWorkRole(user.id, {
        company: 'Smoke Co',
        title: 'Smoke Engineer',
        startDate: new Date('2024-01-01'),
        bullets: [{ text: 'Shipped X', tags: ['go'] }, { text: 'Owned Y' }],
    });
    record('createWorkRole: created + bullets normalized', wr.bullets.length === 2 && wr.bullets[0].id.startsWith('b_'));
    record('createWorkRole: assigns position', typeof wr.position === 'number' && wr.position > 0);

    const wr2 = await updateWorkRole(user.id, wr.id, {
        title: 'Smoke Lead',
        bullets: [...wr.bullets, { text: 'New bullet' }],
    });
    record('updateWorkRole: title updated', wr2?.title === 'Smoke Lead');
    record('updateWorkRole: appended bullet, preserved ids', wr2?.bullets.length === 3 && wr2.bullets[0].id === wr.bullets[0].id);

    const wrDel = await deleteWorkRole(user.id, wr.id);
    record('deleteWorkRole: returns true', wrDel === true);
    const wrDelMissing = await deleteWorkRole(user.id, wr.id);
    record('deleteWorkRole: idempotent (false for unknown id)', wrDelMissing === false);

    // 4. Cross-user ownership check — try updating a workRole that belongs to a different (fake) user.
    const wrOwned = await createWorkRole(user.id, {
        company: 'Owner Co', title: 'Owner', startDate: new Date('2024-01-01'),
    });
    const intruderResult = await updateWorkRole('nonexistent-user-id', wrOwned.id, { title: 'Hijacked' });
    record('updateWorkRole: rejects wrong userId', intruderResult === null);
    await deleteWorkRole(user.id, wrOwned.id);

    // 5. Project CRUD.
    const pr = await createProject(user.id, {
        name: 'Smoke Project',
        repoUrl: 'https://github.com/x/y',
        bullets: [{ text: 'Wrote thing' }],
    });
    record('createProject: created', pr.name === 'Smoke Project' && pr.bullets.length === 1);
    const pr2 = await updateProject(user.id, pr.id, { description: 'desc here' });
    record('updateProject: description updated', pr2?.description === 'desc here');
    await deleteProject(user.id, pr.id);
    record('deleteProject: ok', true);

    // 6. Education CRUD.
    const ed = await createEducation(user.id, {
        institution: 'Smoke U',
        degree: 'BS',
        field: 'CS',
        startDate: new Date('2018-09-01'),
        endDate: new Date('2022-06-01'),
    });
    record('createEducation: created', ed.institution === 'Smoke U');
    const ed2 = await updateEducation(user.id, ed.id, { field: 'EE' });
    record('updateEducation: field updated', ed2?.field === 'EE');
    await deleteEducation(user.id, ed.id);
    record('deleteEducation: ok', true);

    // 7. Bullet JSON round-trip integrity — write raw bullets via prisma, parse back.
    const sampleBullets = [
        { id: 'b_test1', text: 'one', tags: ['t1'], locked: true, excluded: false },
        { id: 'b_test2', text: 'two', tags: [], locked: false, excluded: true },
    ];
    const wr3 = await createWorkRole(user.id, {
        company: 'JSON Co', title: 'JSON', startDate: new Date('2024-01-01'),
        bullets: sampleBullets,
    });
    const raw = await prisma.workRole.findUnique({ where: { id: wr3.id }, select: { bullets: true } });
    const parsedFromDb = parseBullets(raw?.bullets ?? null);
    record('Bullet JSON: roundtrip preserves locked/excluded/tags', JSON.stringify(parsedFromDb) === JSON.stringify(sampleBullets));
    await deleteWorkRole(user.id, wr3.id);

    // Summary
    const failed = steps.filter(s => !s.ok);
    console.info(`\n${steps.length - failed.length}/${steps.length} steps passed`);
    if (failed.length) {
        console.error('FAILURES:');
        for (const f of failed) console.error(`  - ${f.name}${f.detail ? ': ' + f.detail : ''}`);
        process.exit(1);
    }
    console.info('All checks passed.');
    process.exit(0);
}

main().catch((e) => { console.error('Script crashed:', e); process.exit(1); });
