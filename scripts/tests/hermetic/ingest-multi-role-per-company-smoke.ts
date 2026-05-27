/**
 * Hermetic smoke for the multi-role-per-company dedup pass in
 * lib/applications/ingest.ts (2026-05-27).
 *
 * Replays the ingest decision tree against the repository helpers directly
 * (same pattern as ingest-cross-track-dedup-smoke.ts) — a full Gmail-API
 * integration belongs in an integration test, not a hermetic smoke.
 *
 * What we assert:
 *   A. Two existing apps at the same company on the same track but with
 *      DIFFERENT normalizedRole: findApplicationByCompanyAndRole picks
 *      the matching one, NOT the other. (The core fix.)
 *   B. Same (company, role) exists across BOTH kanbans: cross-track
 *      lookup returns most-recently-updated by default.
 *   C. Track-scoped lookup respects the track filter (used by
 *      track-as-application).
 *   D. NULL normalizedRole row is invisible to the new helper — needs
 *      backfill. Confirms the helper short-circuits on empty role key.
 *
 *   DATABASE_URL="file:./dev.db" npx tsx scripts/tests/hermetic/ingest-multi-role-per-company-smoke.ts
 */
import { PrismaClient } from "@prisma/client";
import { randomBytes } from "crypto";

import {
    createApplication,
    findApplicationByCompanyAndRole,
    findApplicationBySourceJobId,
} from "@/lib/repositories/applications";

const prisma = new PrismaClient();
let passed = 0;
let failed = 0;
function check(name: string, condition: boolean, detail?: string) {
    if (condition) { console.log(`[PASS] ${name}`); passed++; }
    else { console.error(`[FAIL] ${name}${detail ? ` — ${detail}` : ""}`); failed++; }
}

async function main() {
    const tag = randomBytes(4).toString("hex");
    const userId = `multi-role-ingest-${tag}`;
    const createdIds: string[] = [];

    try {
        await prisma.user.create({ data: { id: userId, email: `multi-role-ingest-${tag}@example.invalid` } });

        // ─── Case A: two roles at same company on same track ──────────────
        const museum = await createApplication({
            userId,
            company: "Allied Universal",
            role: "Security Officer Part Time Museum Rover",
            status: "INTERESTED",
            kind: "job",
            track: "side",
        });
        createdIds.push(museum.id);
        const mall = await createApplication({
            userId,
            company: "Allied Universal",
            role: "Security Officer Mall Patrol",
            status: "INTERESTED",
            kind: "job",
            track: "side",
        });
        createdIds.push(mall.id);

        check("case A: museum app has normalizedRole populated",
            museum.normalizedRole === "security officer museum rover",
            `got ${JSON.stringify(museum.normalizedRole)}`);
        check("case A: mall app has different normalizedRole",
            mall.normalizedRole === "security officer mall patrol",
            `got ${JSON.stringify(mall.normalizedRole)}`);

        // The ingest path's first lookup: incoming Gmail email about the
        // museum role must return the museum app, not the mall app.
        const lookedMuseum = await findApplicationByCompanyAndRole(
            userId,
            "Allied Universal",
            "Security Officer Museum Rover", // role text drifted from email body
        );
        check("case A: museum lookup returns the museum app",
            lookedMuseum?.id === museum.id,
            `got ${JSON.stringify(lookedMuseum?.id)}`);

        const lookedMall = await findApplicationByCompanyAndRole(
            userId,
            "Allied Universal",
            "Security Officer (Mall Patrol)",
        );
        check("case A: mall lookup returns the mall app",
            lookedMall?.id === mall.id,
            `got ${JSON.stringify(lookedMall?.id)}`);

        // ─── Case B: same (company, role) on both tracks → cross-track ─────
        const careerSE = await createApplication({
            userId,
            company: "Octocat Robotics",
            role: "Software Engineer",
            status: "INTERESTED",
            kind: "job",
            track: "career",
        });
        createdIds.push(careerSE.id);
        // Sleep tick so the side row is strictly more recent.
        await new Promise(r => setTimeout(r, 5));
        const sideSE = await createApplication({
            userId,
            company: "Octocat Robotics",
            role: "Software Engineer",
            status: "INTERESTED",
            kind: "job",
            track: "side",
        });
        createdIds.push(sideSE.id);

        const lookedCrossTrack = await findApplicationByCompanyAndRole(
            userId,
            "Octocat Robotics",
            "Software Engineer",
        );
        check("case B: cross-track lookup returns most-recent (side)",
            lookedCrossTrack?.id === sideSE.id,
            `got ${JSON.stringify(lookedCrossTrack?.id)}, track=${lookedCrossTrack?.track ?? "n/a"}`);

        // ─── Case C: track-scoped lookup ──────────────────────────────────
        const lookedCareerScoped = await findApplicationByCompanyAndRole(
            userId,
            "Octocat Robotics",
            "Software Engineer",
            "career",
        );
        check("case C: track=career returns the career row",
            lookedCareerScoped?.id === careerSE.id,
            `got ${JSON.stringify(lookedCareerScoped?.id)}`);

        // ─── Case D: empty role key → null ────────────────────────────────
        const lookedEmptyRole = await findApplicationByCompanyAndRole(
            userId,
            "Allied Universal",
            "", // empty
        );
        check("case D: empty role short-circuits to null",
            lookedEmptyRole === null,
            `got ${JSON.stringify(lookedEmptyRole?.id ?? null)}`);

        const lookedAllNoise = await findApplicationByCompanyAndRole(
            userId,
            "Allied Universal",
            "Part Time Full Time Remote", // normalizes to "" after noise-strip
        );
        check("case D: all-noise role short-circuits to null",
            lookedAllNoise === null,
            `got ${JSON.stringify(lookedAllNoise?.id ?? null)}`);

        // ─── Case E: sourceJobId helper ───────────────────────────────────
        const linkedApp = await createApplication({
            userId,
            company: "Hooli",
            role: "Backend Engineer",
            status: "INTERESTED",
            kind: "job",
            track: "career",
            sourceJobId: `LINKEDIN-${tag}-998877`,
        });
        createdIds.push(linkedApp.id);

        const lookedBySourceJob = await findApplicationBySourceJobId(userId, `LINKEDIN-${tag}-998877`);
        check("case E: findApplicationBySourceJobId returns the matching row",
            lookedBySourceJob?.id === linkedApp.id);

        const lookedBySourceJobMiss = await findApplicationBySourceJobId(userId, `LINKEDIN-${tag}-NOMATCH`);
        check("case E: sourceJobId miss returns null", lookedBySourceJobMiss === null);

        const lookedBySourceJobEmpty = await findApplicationBySourceJobId(userId, "");
        check("case E: empty sourceJobId short-circuits to null", lookedBySourceJobEmpty === null);
    } finally {
        for (const id of createdIds) {
            await prisma.application.delete({ where: { id } }).catch(() => undefined);
        }
        await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
        await prisma.$disconnect();
        console.log(`\n${passed}/${passed + failed} steps passed`);
    }
    if (failed > 0) process.exit(1);
}

main().catch(e => {
    console.error("Unhandled error:", e);
    process.exit(2);
});
