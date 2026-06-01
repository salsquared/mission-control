/**
 * Hermetic smoke: "last-one-out" side-canon cleanup on watchlist delete.
 *
 * Seeds throwaway rows in the dev SQLite DB (cleaned up via the test user's
 * cascade in finally) and exercises lib/watchlists/cascade-canon.ts:
 * deleteOrphanedSideCanon — the helper the watchlist DELETE route calls after
 * removing a watchlist. Asserts:
 *   1. last watchlist gone  → side canon deleted, BUT its GeneratedResume
 *      survives with canonId nulled (onDelete: SetNull).
 *   2. a sibling watchlist still feeds the canon → canon kept.
 *   3. a CAREER canon is never auto-deleted, even with zero watchlists.
 *   4. null canonId → no-op (no throw).
 *
 * Run: DATABASE_URL="file:./dev.db" npx tsx scripts/tests/hermetic/watchlist-delete-canon-cascade-smoke.ts
 */
import { prisma } from "@/lib/prisma";
import { deleteOrphanedSideCanon } from "@/lib/watchlists/cascade-canon";
import { randomUUID } from "node:crypto";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean): void {
    if (cond) { passed++; console.log(`  ✓ ${name}`); }
    else { failed++; console.error(`  ✗ ${name}`); }
}

const TEST_USER_ID = `test-user-${randomUUID()}`;

async function makeWatchlist(name: string, canonId: string): Promise<string> {
    const w = await prisma.watchlist.create({
        data: {
            userId: TEST_USER_ID,
            name,
            kind: "linkedin",
            config: JSON.stringify({ kind: "linkedin", keywords: name }),
            track: "side",
            canonId,
        },
        select: { id: true },
    });
    return w.id;
}

async function makeCanon(name: string, track: string): Promise<string> {
    const c = await prisma.canon.create({
        data: { userId: TEST_USER_ID, name, slug: `${name}-${randomUUID()}`, track },
        select: { id: true },
    });
    return c.id;
}

async function canonExists(id: string): Promise<boolean> {
    return (await prisma.canon.findUnique({ where: { id }, select: { id: true } })) !== null;
}

async function main(): Promise<void> {
    await prisma.user.create({ data: { id: TEST_USER_ID, email: `${TEST_USER_ID}@test.local` } });
    try {
        // ── Case 1: last-one-out → canon deleted, resume preserved ──────────
        {
            const canonId = await makeCanon("Solo Side Canon", "side");
            const wId = await makeWatchlist("solo side watchlist", canonId);
            const resume = await prisma.generatedResume.create({
                data: {
                    userId: TEST_USER_ID,
                    canonId,
                    isCanonical: true,
                    canonVersion: 1,
                    postingInput: JSON.stringify({ parsedKeywords: [] }),
                    profileSnapshot: "{}",
                    selections: "[]",
                    format: "pdf",
                    status: "ready",
                    artifactPath: "data/resumes/test.pdf",
                },
                select: { id: true },
            });

            await prisma.watchlist.delete({ where: { id: wId } });
            const deleted = await deleteOrphanedSideCanon(TEST_USER_ID, canonId);

            check("case1: helper returns the deleted canonId", deleted === canonId);
            check("case1: side canon row is gone", !(await canonExists(canonId)));
            const r = await prisma.generatedResume.findUnique({ where: { id: resume.id }, select: { id: true, canonId: true } });
            check("case1: generated resume STILL EXISTS", r !== null);
            check("case1: resume.canonId nulled (SetNull, not deleted)", r?.canonId === null);
        }

        // ── Case 2: sibling watchlist still feeds the canon → kept ──────────
        {
            const canonId = await makeCanon("Shared Side Canon", "side");
            const wKeep = await makeWatchlist("shared keep (indeed half)", canonId);
            const wDrop = await makeWatchlist("shared drop (linkedin half)", canonId);

            await prisma.watchlist.delete({ where: { id: wDrop } });
            const deleted = await deleteOrphanedSideCanon(TEST_USER_ID, canonId);

            check("case2: helper returns null (not last-one-out)", deleted === null);
            check("case2: shared canon kept while a sibling remains", await canonExists(canonId));
            // cleanup-ish: remove the survivor so finally's cascade is clean
            void wKeep;
        }

        // ── Case 3: career canon never auto-deleted ─────────────────────────
        {
            const canonId = await makeCanon("Hand-made Career Canon", "career");
            // zero linked watchlists — still must NOT be auto-deleted
            const deleted = await deleteOrphanedSideCanon(TEST_USER_ID, canonId);
            check("case3: helper returns null for a career canon", deleted === null);
            check("case3: career canon preserved", await canonExists(canonId));
        }

        // ── Case 4: null canonId → no-op ────────────────────────────────────
        {
            const deleted = await deleteOrphanedSideCanon(TEST_USER_ID, null);
            check("case4: null canonId is a no-op", deleted === null);
        }
    } finally {
        await prisma.user.delete({ where: { id: TEST_USER_ID } }).catch(() => {});
        await prisma.$disconnect();
    }
    const exitCode = failed === 0 ? 0 : 1;
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(exitCode);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
