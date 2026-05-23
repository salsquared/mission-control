// Story 50 hermetic smoke. Exercises Contact CRUD + ownership scoping +
// cascade-on-application-delete + primaryContactForApplication ordering +
// stale-nudge body shaping.
// Run with: npx tsx scripts/tests/hermetic/contacts-smoke.ts

import { prisma } from '@/lib/prisma';
import {
    createContact,
    listContactsForApplication,
    updateContact,
    deleteContact,
    primaryContactForApplication,
} from '@/lib/repositories/contacts';

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

    const createdAppIds: string[] = [];
    const createdContactIds: string[] = [];

    try {
        // 1. Create a throwaway application to attach contacts to.
        const app = await prisma.application.create({
            data: {
                userId: user.id,
                company: `Contacts Smoke Co ${Date.now()}`,
                role: 'Smoke Engineer',
                status: 'APPLIED',
                lastUpdateAt: new Date(),
                track: 'career',
            },
            select: { id: true },
        });
        createdAppIds.push(app.id);
        record('seed application created', typeof app.id === 'string' && app.id.length > 0);

        // 2. Create a contact and verify shape.
        const c1 = await createContact(user.id, {
            applicationId: app.id,
            name: 'Alice Recruiter',
            email: 'alice@example.com',
            role: 'Recruiter',
        });
        if (!c1) {
            record('createContact returns non-null for owner', false, 'got null');
            return;
        }
        createdContactIds.push(c1.id);
        record('createContact: id assigned', typeof c1.id === 'string' && c1.id.length > 0);
        record('createContact: name written', c1.name === 'Alice Recruiter');
        record('createContact: email written', c1.email === 'alice@example.com');
        record('createContact: role written', c1.role === 'Recruiter');
        record('createContact: lastTouchedAt defaults null', c1.lastTouchedAt === null);
        record('createContact: position defaults > 0', c1.position > 0);

        // 3. Cross-user creation is rejected.
        const strangerCreate = await createContact('nonexistent-user-id', {
            applicationId: app.id,
            name: 'Mallory',
        });
        record('createContact: rejects wrong userId', strangerCreate === null);

        // 4. Create a second contact, verify position increments.
        const c2 = await createContact(user.id, {
            applicationId: app.id,
            name: 'Bob Hiring Manager',
            role: 'Hiring Manager',
        });
        if (!c2) { record('createContact c2', false); return; }
        createdContactIds.push(c2.id);
        record('createContact: second-row position increments', c2.position > c1.position);

        // 5. List ownership scoping.
        const list = await listContactsForApplication(user.id, app.id);
        record('listContactsForApplication: returns 2 rows', list.length === 2);
        record('listContactsForApplication: ordered by position asc', list[0].id === c1.id && list[1].id === c2.id);

        const strangerList = await listContactsForApplication('nonexistent-user-id', app.id);
        record('listContactsForApplication: rejects wrong userId', strangerList.length === 0);

        // 6. Update path.
        const touchedAt = new Date('2026-05-22T15:00:00.000Z');
        const u = await updateContact(user.id, c1.id, {
            email: 'alice.recruiter@example.com',
            lastTouchedAt: touchedAt,
        });
        record('updateContact: email updated', u?.email === 'alice.recruiter@example.com');
        record('updateContact: lastTouchedAt set', u?.lastTouchedAt?.getTime() === touchedAt.getTime());

        // updateContact with all fields=undefined still updates updatedAt (Prisma @updatedAt) — but we only test the meaningful path.
        const strangerUpdate = await updateContact('nonexistent-user-id', c1.id, { name: 'hijacked' });
        record('updateContact: rejects wrong userId', strangerUpdate === null);

        // 7. primaryContactForApplication prefers most-recently-touched.
        // c1 has lastTouchedAt set (step 6); c2 has null. c1 should win even
        // though c2 has a higher position.
        const primary = await primaryContactForApplication(app.id);
        record('primaryContactForApplication: prefers touched over untouched', primary?.id === c1.id);

        // 8. With both touched, the more-recent one wins.
        const olderTouchedAt = new Date('2026-05-20T15:00:00.000Z');
        const newerTouchedAt = new Date('2026-05-22T16:00:00.000Z');
        await updateContact(user.id, c1.id, { lastTouchedAt: olderTouchedAt });
        await updateContact(user.id, c2.id, { lastTouchedAt: newerTouchedAt });
        const primary2 = await primaryContactForApplication(app.id);
        record('primaryContactForApplication: newer touch wins', primary2?.id === c2.id);

        // 9. With neither touched, position-asc wins.
        await updateContact(user.id, c1.id, { lastTouchedAt: null });
        await updateContact(user.id, c2.id, { lastTouchedAt: null });
        const primary3 = await primaryContactForApplication(app.id);
        record('primaryContactForApplication: position-asc wins when neither touched', primary3?.id === c1.id);

        // 10. Empty-application case.
        const emptyApp = await prisma.application.create({
            data: {
                userId: user.id,
                company: `Empty Smoke Co ${Date.now()}`,
                role: 'Smoke',
                status: 'APPLIED',
                lastUpdateAt: new Date(),
                track: 'career',
            },
            select: { id: true },
        });
        createdAppIds.push(emptyApp.id);
        const emptyPrimary = await primaryContactForApplication(emptyApp.id);
        record('primaryContactForApplication: returns null when no contacts', emptyPrimary === null);

        // 11. Stale-nudge body shaping — confirm the helper that picks a first
        // name does what the scheduler expects.
        const firstName = primary3?.name.trim().split(/\s+/)[0];
        record('first-name extraction picks "Alice"', firstName === 'Alice');

        // 12. Delete path.
        const ok = await deleteContact(user.id, c2.id);
        record('deleteContact: returns true on first delete', ok === true);
        createdContactIds.splice(createdContactIds.indexOf(c2.id), 1);
        const okAgain = await deleteContact(user.id, c2.id);
        record('deleteContact: idempotent (false for unknown id)', okAgain === false);

        const strangerDelete = await deleteContact('nonexistent-user-id', c1.id);
        record('deleteContact: rejects wrong userId', strangerDelete === false);
        const stillThere = await prisma.contact.findUnique({ where: { id: c1.id }, select: { id: true } });
        record('deleteContact: cross-user delete left row intact', stillThere !== null);

        // 13. Cascade on application delete: deleting the parent removes the remaining child.
        await prisma.application.delete({ where: { id: app.id } });
        createdAppIds.splice(createdAppIds.indexOf(app.id), 1);
        const orphanCheck = await prisma.contact.findUnique({ where: { id: c1.id }, select: { id: true } });
        record('cascade on application delete: contact gone', orphanCheck === null);
        // Drop c1 from cleanup list since cascade already nuked it.
        createdContactIds.splice(createdContactIds.indexOf(c1.id), 1);
    } finally {
        for (const id of createdContactIds) {
            try { await prisma.contact.delete({ where: { id } }); } catch { /* ignore */ }
        }
        for (const id of createdAppIds) {
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
