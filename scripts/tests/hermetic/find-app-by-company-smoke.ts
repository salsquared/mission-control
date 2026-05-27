/**
 * Hermetic smoke for PB-7 (was RAH-8) — `findApplicationByCompany` after the
 * substring→exact (case-insensitive) switch.
 *
 *   DATABASE_URL="file:./dev.db" npx tsx scripts/tests/hermetic/find-app-by-company-smoke.ts
 *
 * Asserts the $queryRaw with LOWER() actually compiles + runs on SQLite and
 * returns the expected matches: case-insensitive equality, NOT substring.
 *   - "Acme" matches "acme" (case-insensitive)
 *   - "Acme" does NOT match "Acme Corp" (no substring)
 *   - "AI" does NOT match "Sail-AI" (the exact bug the patch closes)
 *   - cross-user isolation preserved
 *
 * No HTTP / no session.
 */
import { PrismaClient } from "@prisma/client";
import { randomBytes } from "crypto";

import { findApplicationByCompany } from "@/lib/repositories/applications";

const prisma = new PrismaClient();
let passes = 0;
let fails = 0;
function pass(msg: string) { console.log(`[PASS] ${msg}`); passes++; }
function fail(msg: string, detail?: unknown) { console.error(`[FAIL] ${msg}`, detail ?? ""); fails++; }

async function main() {
    const tag = randomBytes(4).toString("hex");
    const userId = `find-app-smoke-${tag}`;
    const otherUserId = `find-app-smoke-other-${tag}`;
    const appIds: string[] = [];

    try {
        await prisma.user.create({ data: { id: userId, email: `find-app-smoke-${tag}@example.invalid` } });
        await prisma.user.create({ data: { id: otherUserId, email: `find-app-smoke-other-${tag}@example.invalid` } });

        const acme = await prisma.application.create({
            data: { userId, company: "Acme", role: "Engineer", status: "APPLIED", kind: "job", track: "career" },
        });
        const acmeCorp = await prisma.application.create({
            data: { userId, company: "Acme Corp", role: "Engineer", status: "APPLIED", kind: "job", track: "career" },
        });
        const sailAI = await prisma.application.create({
            data: { userId, company: "Sail-AI", role: "Engineer", status: "APPLIED", kind: "job", track: "career" },
        });
        const otherUserAcme = await prisma.application.create({
            data: { userId: otherUserId, company: "Acme", role: "Engineer", status: "APPLIED", kind: "job", track: "career" },
        });
        appIds.push(acme.id, acmeCorp.id, sailAI.id, otherUserAcme.id);

        // 1. Case-insensitive exact match — "acme" matches "Acme" not "Acme Corp"
        const m1 = await findApplicationByCompany(userId, "acme", "career");
        if (m1?.id !== acme.id) fail(`"acme" should match "Acme", got ${m1?.company ?? "null"}`);
        else pass(`case-insensitive: "acme" matches "Acme"`);

        // 2. Exact-case match
        const m2 = await findApplicationByCompany(userId, "Acme", "career");
        if (m2?.id !== acme.id) fail(`"Acme" should match exact, got ${m2?.company ?? "null"}`);
        else pass(`exact case: "Acme" matches "Acme"`);

        // 3. Substring should NOT match — the entire bug PB-7 (was RAH-8) closed
        const m3 = await findApplicationByCompany(userId, "Acme C", "career");
        if (m3 !== null) fail(`"Acme C" should NOT match anything (no substring), got ${m3.company}`);
        else pass(`no substring match: "Acme C" returns null`);

        // 4. The "AI" / "Sail-AI" case from the bug description
        const m4 = await findApplicationByCompany(userId, "AI", "career");
        if (m4 !== null) fail(`"AI" should NOT match "Sail-AI" (no substring), got ${m4.company}`);
        else pass(`no substring match: "AI" doesn't match "Sail-AI"`);

        // 5. Cross-user isolation — same company name on another user's row must not leak
        const m5 = await findApplicationByCompany(`find-app-smoke-nonexistent-${tag}`, "Acme", "career");
        if (m5 !== null) fail(`nonexistent user should return null, got ${m5.company}`);
        else pass(`cross-user: foreign userId returns null`);

        // 6. otherUser sees their own "Acme", not ours
        const m6 = await findApplicationByCompany(otherUserId, "Acme", "career");
        if (m6?.id !== otherUserAcme.id) fail(`other user should see their own Acme, got ${m6?.id ?? "null"}`);
        else pass(`cross-user: other user gets their own row`);

        // 7. Exact match on "Acme Corp"
        const m7 = await findApplicationByCompany(userId, "ACME CORP", "career");
        if (m7?.id !== acmeCorp.id) fail(`"ACME CORP" should match "Acme Corp" case-insensitively, got ${m7?.company ?? "null"}`);
        else pass(`case-insensitive: "ACME CORP" matches "Acme Corp"`);
    } finally {
        for (const id of appIds) await prisma.application.delete({ where: { id } }).catch(() => undefined);
        await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
        await prisma.user.delete({ where: { id: otherUserId } }).catch(() => undefined);
        await prisma.$disconnect();
        console.log(`\n${passes}/${passes + fails} steps passed`);
        if (fails === 0) console.log("All checks passed.");
    }
    if (fails > 0) process.exit(1);
}

main().catch(e => {
    console.error("Unhandled error:", e);
    process.exit(2);
});
