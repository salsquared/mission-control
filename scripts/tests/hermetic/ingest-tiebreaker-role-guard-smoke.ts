/**
 * Hermetic smoke for the senderDomain tie-breaker ROLE GUARD + tolerant ingest
 * update (2026-06-01).
 *
 * Background — the bug this guards against (the "Rocket Lab" inbox-scan crash):
 *   An employer can have many roles but only ONE row carries a senderDomain
 *   (the role you actually got an email from — e.g. Rocket Lab, where only the
 *   applied "Software Intern" row had rocketlabusa.com stamped). The
 *   senderDomain tie-breaker in ingest.ts only checked that the COMPANY matched
 *   before redirecting the update to the domain-stamped row — it ignored the
 *   ROLE. So a confirmation email for "Integration & Test Intern" correctly
 *   matched its own row, then got REDIRECTED onto the "Software Intern" row,
 *   and the subsequent role-rename collided with the sibling that legitimately
 *   owned (Rocket Lab, "integration test ...", career) → unhandled Prisma
 *   P2002 → the whole inbox scan 500'd ("Scan failed").
 *
 * What we assert:
 *   A. Role guard: email whose role matches a NON-domain row does NOT get
 *      redirected to the domain-stamped sibling with a different role.
 *   B. Legit cross-track tie-breaker still fires: when the domain-stamped row
 *      shares the incoming role, the redirect (to prefer the domain track)
 *      still happens — the guard didn't break the feature it lives inside.
 *   C. updateApplicationTolerant: a role-rename that WOULD violate the
 *      @@unique(company,role,track) index does NOT throw — it re-applies the
 *      non-key fields (status/nextSteps) and leaves the colliding sibling and
 *      the matched row's own role untouched.
 *   D. Source guards: ingest.ts carries the role-equality check in the
 *      tie-breaker and routes its updates through updateApplicationTolerant;
 *      the backfill route wraps ingest in a per-message try/catch.
 *
 * Replays the ingest decision tree against the repository helpers directly —
 * same pattern as ingest-cross-track-dedup-smoke.ts.
 *
 *   DATABASE_URL="file:./dev.db" npx tsx scripts/tests/hermetic/ingest-tiebreaker-role-guard-smoke.ts
 */
import { PrismaClient } from "@prisma/client";
import { randomBytes } from "crypto";
import { readFileSync } from "fs";
import { resolve } from "path";

import { normalizeCompanyName } from "@/lib/applications/normalize-company";
import {
    createApplication,
    findApplicationByCompanyAndRole,
    findApplicationBySenderDomain,
} from "@/lib/repositories/applications";
import { updateApplicationTolerant } from "@/lib/applications/ingest";

const prisma = new PrismaClient();
let passed = 0;
let failed = 0;
function check(name: string, condition: boolean, detail?: string) {
    if (condition) { console.log(`[PASS] ${name}`); passed++; }
    else { console.error(`[FAIL] ${name}${detail ? ` — ${detail}` : ""}`); failed++; }
}

/**
 * Faithful replica of ingest.ts's step-2 lookup + GUARDED senderDomain
 * tie-breaker. Kept in lockstep with the source via the case-D source check.
 */
async function resolveExisting(userId: string, company: string, incomingRole: string, senderDomain: string) {
    let existingApp = await findApplicationByCompanyAndRole(userId, company, incomingRole);
    let redirected = false;
    if (existingApp && senderDomain && existingApp.senderDomain !== senderDomain) {
        const byDomain = await findApplicationBySenderDomain(userId, senderDomain);
        if (
            byDomain
            && byDomain.id !== existingApp.id
            && normalizeCompanyName(byDomain.company) === normalizeCompanyName(existingApp.company)
            && byDomain.normalizedRole === existingApp.normalizedRole
        ) {
            existingApp = byDomain;
            redirected = true;
        }
    }
    return { existingApp, redirected };
}

async function main() {
    const tag = randomBytes(4).toString("hex");
    const userId = `tiebrk-guard-smoke-${tag}`;
    const createdIds: string[] = [];

    try {
        await prisma.user.create({
            data: { id: userId, email: `tiebrk-guard-smoke-${tag}@example.invalid` },
        });

        // ─── Case A: role guard blocks the cross-role redirect ──────────────
        //
        // Acme has two career rows with DIFFERENT roles. Only "Data Scientist"
        // carries the senderDomain (the role we got an email from). An email
        // for "Software Engineer" arrives from acme.com.
        const sweCareer = await createApplication({
            userId, company: "Acme", role: "Software Engineer",
            status: "APPLIED", kind: "job", track: "career",
        });
        createdIds.push(sweCareer.id);
        await new Promise((r) => setTimeout(r, 5));
        const dsCareer = await createApplication({
            userId, company: "Acme", role: "Data Scientist",
            status: "APPLIED", kind: "job", track: "career",
            senderDomain: "acme.com", // the lone domain-stamped sibling
        });
        createdIds.push(dsCareer.id);

        const a = await resolveExisting(userId, "Acme", "Software Engineer", "acme.com");
        check(
            "case A: SWE email matches the SWE row (not redirected to the domain row)",
            a.existingApp?.id === sweCareer.id && !a.redirected,
            `got id=${a.existingApp?.id ?? "null"} (role=${a.existingApp?.role ?? "n/a"}) redirected=${a.redirected}`,
        );

        // ─── Case B: legit same-role cross-track tie-breaker still fires ─────
        //
        // Beta has the SAME role ("Eng") on both tracks; the side row carries
        // the domain. The career row is newer (so step-2 returns it first). The
        // guarded tie-breaker should still prefer the domain-stamped side row,
        // because the roles match.
        const betaSide = await createApplication({
            userId, company: "Beta", role: "Eng",
            status: "INTERESTED", kind: "job", track: "side",
            senderDomain: "beta.com",
        });
        createdIds.push(betaSide.id);
        await new Promise((r) => setTimeout(r, 5));
        const betaCareer = await createApplication({
            userId, company: "Beta", role: "Eng",
            status: "APPLIED", kind: "job", track: "career",
        });
        createdIds.push(betaCareer.id);

        const b = await resolveExisting(userId, "Beta", "Eng", "beta.com");
        check(
            "case B: same-role tie-breaker still redirects to the domain (side) row",
            b.existingApp?.id === betaSide.id && b.redirected,
            `got id=${b.existingApp?.id ?? "null"} (track=${b.existingApp?.track ?? "n/a"}) redirected=${b.redirected}`,
        );

        // ─── Case C: updateApplicationTolerant swallows the unique collision ─
        //
        // Renaming the "Data Scientist" row to "Software Engineer" would collide
        // with sweCareer on (Acme, software engineer, career). The tolerant
        // helper must NOT throw: it re-applies status/nextSteps without the
        // role rename.
        let threw = false;
        try {
            await updateApplicationTolerant(dsCareer.id, {
                role: "Software Engineer",   // <- the colliding rename
                status: "REJECTED",
                nextSteps: "thanks for applying",
            }, { msgId: "smoke-msg" });
        } catch {
            threw = true;
        }
        check("case C: tolerant update does NOT throw on the unique collision", !threw);

        const dsAfter = await prisma.application.findUnique({ where: { id: dsCareer.id } });
        check(
            "case C: matched row keeps its own role (rename was dropped)",
            dsAfter?.role === "Data Scientist" && dsAfter?.normalizedRole === "data scientist",
            `got role=${JSON.stringify(dsAfter?.role)} normRole=${JSON.stringify(dsAfter?.normalizedRole)}`,
        );
        check(
            "case C: non-key fields (status/nextSteps) still landed",
            dsAfter?.status === "REJECTED" && dsAfter?.nextSteps === "thanks for applying",
            `got status=${JSON.stringify(dsAfter?.status)} nextSteps=${JSON.stringify(dsAfter?.nextSteps)}`,
        );
        const sweAfter = await prisma.application.findUnique({ where: { id: sweCareer.id } });
        check(
            "case C: the colliding sibling is untouched",
            sweAfter?.role === "Software Engineer" && sweAfter?.status === "APPLIED",
            `got role=${JSON.stringify(sweAfter?.role)} status=${JSON.stringify(sweAfter?.status)}`,
        );

        // ─── Case D: source-level regression guards ─────────────────────────
        const ingestSrc = readFileSync(
            resolve(__dirname, "../../../lib/applications/ingest.ts"), "utf8",
        );
        check(
            "case D: ingest tie-breaker carries the role-equality guard",
            /byDomain\.normalizedRole\s*===\s*existingApp\.normalizedRole/.test(ingestSrc),
        );
        check(
            "case D: both ingest upsert call sites route through updateApplicationTolerant",
            /updateApplicationTolerant\(existingApp\.id/.test(ingestSrc)
            && /updateApplicationTolerant\(raced\.id/.test(ingestSrc),
        );

        const backfillSrc = readFileSync(
            resolve(__dirname, "../../../app/api/applications/backfill/route.ts"), "utf8",
        );
        check(
            "case D: backfill wraps ingest in a per-message try/catch",
            /catch[\s\S]{0,80}action:\s*"errored"/.test(backfillSrc),
        );
    } finally {
        for (const id of createdIds) {
            await prisma.application.delete({ where: { id } }).catch(() => {});
        }
        await prisma.user.delete({ where: { id: userId } }).catch(() => {});
    }

    console.log(`\n${passed} passed, ${failed} failed.`);
    process.exit(failed === 0 ? 0 : 1);
}

main()
    .catch((e) => { console.error(e); process.exit(1); })
    .finally(() => prisma.$disconnect());
