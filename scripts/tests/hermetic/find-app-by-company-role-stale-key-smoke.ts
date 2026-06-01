/**
 * Hermetic smoke for Fix A (2026-06-01) — `findApplicationByCompanyAndRole`
 * LOWER(company) + strict-normalizedRole fallback.
 *
 *   DATABASE_URL="file:./dev.db" npx tsx \
 *     scripts/tests/hermetic/find-app-by-company-role-stale-key-smoke.ts
 *
 * Regression: the Rocket Lab "Software Intern Fall 2026" duplicate. A row
 * promoted by track-as-application before normalizedCompany was written inline
 * landed with a NULL/empty normalizedCompany but a populated normalizedRole.
 * The indexed primary lookup matched the company key exactly, so it missed the
 * stale row entirely, and Gmail ingest spawned a SECOND kanban card for an
 * application the user already had.
 *
 * The fallback matches the company on LOWER(company) (tolerant of a stale /
 * empty company key) while keeping the role strict on the normalized key.
 * This asserts:
 *   1. empty normalizedCompany + matching role          → fallback MATCHES
 *   2. drifted (wrong) normalizedCompany + matching role → fallback MATCHES
 *   3. a genuinely different role at the same employer   → does NOT match
 *      (multi-role-per-company preserved)
 *   4. a roleless row (normalizedRole NULL)              → does NOT match
 *      (falls through to ingest's company-only / senderDomain branches)
 *   5. the indexed path still wins for a correctly-normalized row
 *   6. track scoping + cross-user isolation hold
 *
 * Uses normalizedCompany:"" (empty) rather than null for the stale rows so the
 * test still exercises the fallback after Fix B makes the column NOT NULL
 * (NOT NULL rejects null, not ""). No HTTP / no session.
 */
import { PrismaClient } from "@prisma/client";
import { randomBytes } from "crypto";

import { findApplicationByCompanyAndRole } from "@/lib/repositories/applications";
import { normalizeRoleName } from "@/lib/applications/normalize-role";

const prisma = new PrismaClient();
let passes = 0;
let fails = 0;
function pass(msg: string) { console.log(`[PASS] ${msg}`); passes++; }
function fail(msg: string, detail?: unknown) { console.error(`[FAIL] ${msg}`, detail ?? ""); fails++; }

async function main() {
    const tag = randomBytes(4).toString("hex");
    const userId = `stale-key-smoke-${tag}`;
    const otherUserId = `stale-key-smoke-other-${tag}`;
    const appIds: string[] = [];

    try {
        await prisma.user.create({ data: { id: userId, email: `stale-key-smoke-${tag}@example.invalid` } });
        await prisma.user.create({ data: { id: otherUserId, email: `stale-key-smoke-other-${tag}@example.invalid` } });

        // The original card: company present, normalizedCompany EMPTY (the
        // legacy track-as-application state), normalizedRole populated.
        const stale = await prisma.application.create({
            data: {
                userId, company: "Rocket Lab",
                normalizedCompany: "", normalizedRole: normalizeRoleName("Software Intern Fall 2026"),
                role: "Software Intern Fall 2026", status: "INTERESTED", kind: "job", track: "career",
            },
        });
        // A different role at the SAME employer — must stay distinct.
        const otherRole = await prisma.application.create({
            data: {
                userId, company: "Rocket Lab",
                normalizedCompany: "", normalizedRole: normalizeRoleName("Propulsion Analyst Fall 2026"),
                role: "Propulsion Analyst Fall 2026", status: "INTERESTED", kind: "job", track: "career",
            },
        });
        // A roleless row at the same employer (normalizedRole NULL) — must NOT
        // be caught by the role-strict fallback.
        const roleless = await prisma.application.create({
            data: {
                userId, company: "Rocket Lab",
                normalizedCompany: "", normalizedRole: null,
                role: "Unknown", status: "INTERESTED", kind: "job", track: "career",
            },
        });
        // A correctly-normalized row at a different employer — indexed path.
        const indexed = await prisma.application.create({
            data: {
                userId, company: "Acme",
                normalizedCompany: "Acme", normalizedRole: normalizeRoleName("Software Engineer"),
                role: "Software Engineer", status: "APPLIED", kind: "job", track: "career",
            },
        });
        // Cross-user row with the same stale shape — must not leak.
        const otherUserStale = await prisma.application.create({
            data: {
                userId: otherUserId, company: "Rocket Lab",
                normalizedCompany: "", normalizedRole: normalizeRoleName("Software Intern Fall 2026"),
                role: "Software Intern Fall 2026", status: "INTERESTED", kind: "job", track: "career",
            },
        });
        appIds.push(stale.id, otherRole.id, roleless.id, indexed.id, otherUserStale.id);

        // 1. Empty normalizedCompany + matching role → fallback MATCHES (track-scoped).
        const m1 = await findApplicationByCompanyAndRole(userId, "Rocket Lab", "Software Intern Fall 2026", "career");
        if (m1?.id !== stale.id) fail(`empty-key row should match via fallback, got ${m1?.id ?? "null"}`);
        else pass(`empty normalizedCompany + role match → fallback returns the stale card`);

        // 1b. Track-agnostic (the shape ingest.ts:137 actually calls).
        const m1b = await findApplicationByCompanyAndRole(userId, "Rocket Lab", "Software Intern Fall 2026");
        if (m1b?.id !== stale.id) fail(`track-agnostic fallback should match, got ${m1b?.id ?? "null"}`);
        else pass(`track-agnostic fallback returns the stale card`);

        // 2. Drifted (wrong, non-empty) normalizedCompany + matching role → fallback MATCHES.
        await prisma.application.update({ where: { id: stale.id }, data: { normalizedCompany: "rocketlab-OLD-KEY" } });
        const m2 = await findApplicationByCompanyAndRole(userId, "Rocket Lab", "Software Intern Fall 2026", "career");
        if (m2?.id !== stale.id) fail(`drifted-key row should match via fallback, got ${m2?.id ?? "null"}`);
        else pass(`drifted normalizedCompany + role match → fallback returns the card`);

        // 3. A genuinely different role at the same employer is NOT pulled in by
        //    a Software-Intern lookup (multi-role-per-company preserved).
        const m3 = await findApplicationByCompanyAndRole(userId, "Rocket Lab", "Propulsion Analyst Fall 2026", "career");
        if (m3?.id !== otherRole.id) fail(`different-role lookup should return its own row, got ${m3?.id ?? "null"}`);
        else pass(`different role at same employer stays a distinct row`);

        // 4. The roleless row (normalizedRole NULL) is NOT matched by the
        //    role-strict fallback — a lookup for a concrete role must skip it.
        //    (Construct a company that ONLY has the roleless + otherRole rows so
        //    a Mission-Operation lookup can't accidentally hit a real match.)
        const m4 = await findApplicationByCompanyAndRole(userId, "Rocket Lab", "Mission Operation Intern Fall 2026", "career");
        if (m4 !== null) fail(`roleless row must not match a concrete-role lookup, got ${m4.id} (role=${JSON.stringify(m4.role)})`);
        else pass(`roleless row not caught by role-strict fallback`);

        // 5. Indexed path still wins for a correctly-normalized row.
        const m5 = await findApplicationByCompanyAndRole(userId, "Acme", "Software Engineer", "career");
        if (m5?.id !== indexed.id) fail(`indexed match should return the Acme row, got ${m5?.id ?? "null"}`);
        else pass(`correctly-normalized row matches via indexed path`);

        // 6a. Track scoping — the stale card is on career; a side lookup misses.
        const m6 = await findApplicationByCompanyAndRole(userId, "Rocket Lab", "Software Intern Fall 2026", "side");
        if (m6 !== null) fail(`side-track lookup must not match a career row, got ${m6.id}`);
        else pass(`track scoping: side lookup doesn't match the career stale card`);

        // 6b. Cross-user isolation — another user's identical stale row must not leak.
        const m7 = await findApplicationByCompanyAndRole(`stale-key-smoke-nobody-${tag}`, "Rocket Lab", "Software Intern Fall 2026");
        if (m7 !== null) fail(`nonexistent user should return null, got ${m7.id}`);
        else pass(`cross-user: foreign userId returns null`);
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
