// M7.6.3 hermetic smoke. Exercises listResumeUploads, getResumeUpload,
// findUploadsMatchingParent, deleteResumeUpload end-to-end against dev.db.
// Run with: npx tsx scripts/tests/hermetic/resume-uploads-smoke.ts

import { prisma } from '@/lib/prisma';
import {
    listResumeUploads,
    getResumeUpload,
    findUploadsMatchingParent,
    deleteResumeUpload,
} from '@/lib/repositories/resume-uploads';

interface Step { name: string; ok: boolean; detail?: string }
const steps: Step[] = [];
function record(name: string, ok: boolean, detail?: string) {
    steps.push({ name, ok, detail });
    console.info(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
}

async function createUpload(opts: {
    userId: string;
    filename: string;
    rawText: string;
    parsedJson?: string;
    mimeType?: string;
    sizeBytes?: number;
    uploadedAt?: Date;
    artifactPath?: string | null;
    importBatchId?: string | null;
}): Promise<string> {
    const row = await prisma.resumeUpload.create({
        data: {
            userId: opts.userId,
            filename: opts.filename,
            mimeType: opts.mimeType ?? 'text/plain',
            sizeBytes: opts.sizeBytes ?? Buffer.byteLength(opts.rawText, 'utf8'),
            rawText: opts.rawText,
            parsedJson: opts.parsedJson ?? JSON.stringify({ smoke: true }),
            artifactPath: opts.artifactPath ?? null,
            importBatchId: opts.importBatchId ?? null,
            ...(opts.uploadedAt ? { uploadedAt: opts.uploadedAt } : {}),
        },
        select: { id: true },
    });
    return row.id;
}

async function main() {
    const user = await prisma.user.findFirst({ select: { id: true, email: true } });
    if (!user) {
        console.error('No user in dev.db — log in to the app once before running.');
        process.exit(1);
    }
    console.info(`Using user ${user.email} (${user.id})`);

    // Track every row we create so a mid-test failure still cleans up.
    const createdIds: string[] = [];

    try {
        // 1. Create a baseline upload with distinctive rawText + parsedJson.
        const firstId = await createUpload({
            userId: user.id,
            filename: 'baseline.txt',
            rawText: 'Worked at Acme Corporation 2020-2023 doing widget engineering.',
            parsedJson: JSON.stringify({ companies: ['Acme'], roles: ['engineer'] }),
            sizeBytes: 1234,
            uploadedAt: new Date('2025-01-01T00:00:00Z'),
        });
        createdIds.push(firstId);
        record('seed: created baseline ResumeUpload', typeof firstId === 'string' && firstId.length > 0);

        // 2. listResumeUploads returns the row but EXCLUDES rawText + parsedJson.
        const listAfterFirst = await listResumeUploads(user.id);
        const summary = listAfterFirst.find((r) => r.id === firstId);
        record('listResumeUploads: includes the created row', summary !== undefined);
        const keys = summary ? Object.keys(summary as unknown as Record<string, unknown>) : [];
        record(
            'listResumeUploads: projection excludes rawText',
            !keys.includes('rawText'),
            `keys=${keys.join(',')}`,
        );
        record(
            'listResumeUploads: projection excludes parsedJson',
            !keys.includes('parsedJson'),
            `keys=${keys.join(',')}`,
        );
        record(
            'listResumeUploads: summary surfaces uploadedAt as Date',
            summary?.uploadedAt instanceof Date,
        );
        record(
            'listResumeUploads: summary preserves sizeBytes',
            summary?.sizeBytes === 1234,
        );

        // 3. Create 3 more rows with controlled uploadedAt — assert newest-first.
        const olderId = await createUpload({
            userId: user.id,
            filename: 'older.txt',
            rawText: 'Older resume content with no special markers.',
            uploadedAt: new Date('2024-06-01T00:00:00Z'),
        });
        createdIds.push(olderId);
        const middleId = await createUpload({
            userId: user.id,
            filename: 'middle.txt',
            rawText: 'Middle resume mentions Acme too.',
            uploadedAt: new Date('2025-03-15T00:00:00Z'),
        });
        createdIds.push(middleId);
        const newestId = await createUpload({
            userId: user.id,
            filename: 'newest.txt',
            rawText: 'Newest resume references aCmE in mixed case.',
            uploadedAt: new Date('2025-09-30T00:00:00Z'),
        });
        createdIds.push(newestId);

        const ourIds = new Set([firstId, olderId, middleId, newestId]);
        const list = await listResumeUploads(user.id);
        const ours = list.filter((r) => ourIds.has(r.id));
        // Expect order: newest -> middle -> first -> older
        const expectedOrder = [newestId, middleId, firstId, olderId];
        const actualOrder = ours.map((r) => r.id);
        record(
            'listResumeUploads: newest-first order',
            JSON.stringify(actualOrder) === JSON.stringify(expectedOrder),
            `actual=${actualOrder.join(',')} expected=${expectedOrder.join(',')}`,
        );

        // 4. getResumeUpload returns the full row, including rawText + parsedJson.
        const full = await getResumeUpload(firstId, user.id);
        record('getResumeUpload: returns a row', full !== null);
        record(
            'getResumeUpload: includes rawText',
            full !== null && full.rawText.includes('Acme Corporation'),
        );
        record(
            'getResumeUpload: includes parsedJson',
            full !== null && full.parsedJson.includes('Acme'),
        );
        record(
            'getResumeUpload: includes filename + mimeType',
            full !== null && full.filename === 'baseline.txt' && full.mimeType === 'text/plain',
        );

        // 5. getResumeUpload with a wrong userId returns null (ownership check).
        const wrongUser = await getResumeUpload(firstId, '__not_a_real_user__');
        record('getResumeUpload: rejects wrong userId', wrongUser === null);

        // 6. getResumeUpload with a wrong id returns null.
        const wrongId = await getResumeUpload('__not_a_real_id__', user.id);
        record('getResumeUpload: returns null on unknown id', wrongId === null);

        // 7. findUploadsMatchingParent (work-role / company: 'Acme') — finds
        //    case-insensitive matches, ignores non-matches.
        const acmeHits = await findUploadsMatchingParent(user.id, { kind: 'work-role', company: 'Acme' });
        const acmeIds = new Set(acmeHits.map((r) => r.id));
        record(
            'findUploadsMatchingParent (Acme): hits baseline (Acme Corporation)',
            acmeIds.has(firstId),
        );
        record(
            'findUploadsMatchingParent (Acme): hits middle (Acme)',
            acmeIds.has(middleId),
        );
        record(
            'findUploadsMatchingParent (Acme): hits newest (aCmE mixed case)',
            acmeIds.has(newestId),
        );
        record(
            'findUploadsMatchingParent (Acme): does NOT hit older (no marker)',
            !acmeIds.has(olderId),
        );
        record(
            'findUploadsMatchingParent: rows include rawText (full projection)',
            acmeHits.length > 0 && typeof acmeHits[0].rawText === 'string' && acmeHits[0].rawText.length > 0,
        );
        record(
            'findUploadsMatchingParent: rows include parsedJson',
            acmeHits.length > 0 && typeof acmeHits[0].parsedJson === 'string',
        );
        record(
            'findUploadsMatchingParent: uploadedAt is a Date',
            acmeHits.length > 0 && acmeHits[0].uploadedAt instanceof Date,
        );
        record(
            'findUploadsMatchingParent: sizeBytes is a number',
            acmeHits.length > 0 && typeof acmeHits[0].sizeBytes === 'number',
        );

        // 8. Limit argument is respected (3 Acme hits exist — ask for 2).
        const limited = await findUploadsMatchingParent(user.id, { kind: 'work-role', company: 'Acme' }, 2);
        record(
            'findUploadsMatchingParent: respects limit argument',
            limited.length === 2,
            `len=${limited.length}`,
        );

        // 9. Empty / whitespace / null identifiers => [].
        const emptyName = await findUploadsMatchingParent(user.id, { kind: 'project', name: '' });
        record('findUploadsMatchingParent: empty project name returns []', Array.isArray(emptyName) && emptyName.length === 0);

        // 10. Whitespace-only institution.
        const wsInstitution = await findUploadsMatchingParent(user.id, { kind: 'education', institution: '   ' });
        record('findUploadsMatchingParent: whitespace institution returns []', Array.isArray(wsInstitution) && wsInstitution.length === 0);

        // 11. Null company.
        const nullCompany = await findUploadsMatchingParent(user.id, { kind: 'work-role', company: null });
        record('findUploadsMatchingParent: null company returns []', Array.isArray(nullCompany) && nullCompany.length === 0);

        // 12. Newest-first ordering — already implicit in step 7, but assert
        //     explicitly on the Acme set so a regression in ORDER BY surfaces here.
        const acmeOrder = acmeHits.map((r) => r.id);
        // Among Acme hits, expected order by uploadedAt desc: newest (2025-09) -> middle (2025-03) -> first (2025-01)
        const expectedAcmeOrder = [newestId, middleId, firstId];
        record(
            'findUploadsMatchingParent: orders results newest-first',
            JSON.stringify(acmeOrder) === JSON.stringify(expectedAcmeOrder),
            `actual=${acmeOrder.join(',')} expected=${expectedAcmeOrder.join(',')}`,
        );

        // 13. deleteResumeUpload (valid owner) returns true and removes the row.
        const deletedOk = await deleteResumeUpload(olderId, user.id);
        record('deleteResumeUpload: returns true on owner-scoped hit', deletedOk === true);
        const gone = await prisma.resumeUpload.findUnique({ where: { id: olderId } });
        record('deleteResumeUpload: row is actually gone from the DB', gone === null);
        // Drop from createdIds so the finally block doesn't try to re-delete.
        const olderIdx = createdIds.indexOf(olderId);
        if (olderIdx >= 0) createdIds.splice(olderIdx, 1);

        // 14. deleteResumeUpload (unknown id) returns false.
        const noSuchId = await deleteResumeUpload('__nope__', user.id);
        record('deleteResumeUpload: returns false for unknown id', noSuchId === false);

        // 15. deleteResumeUpload (wrong userId) returns false AND leaves the row.
        const wrongUserDelete = await deleteResumeUpload(firstId, '__not_a_real_user__');
        record('deleteResumeUpload: returns false on wrong userId', wrongUserDelete === false);
        const stillThere = await prisma.resumeUpload.findUnique({ where: { id: firstId } });
        record('deleteResumeUpload: wrong userId leaves row intact', stillThere !== null);
    } finally {
        // Cleanup — best-effort, don't fail the run on a stray.
        for (const id of createdIds) {
            try { await prisma.resumeUpload.delete({ where: { id } }); } catch { /* ignore */ }
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
