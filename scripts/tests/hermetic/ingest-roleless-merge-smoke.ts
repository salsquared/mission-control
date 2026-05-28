/**
 * Hermetic smoke for the roleless-email company merge in
 * lib/applications/ingest.ts (2026-05-28).
 *
 * Background — the bug this guards against:
 *   A generic ATS email ("Instructions for Completing Your Form Later",
 *   "finish your application") carries no role. The classifier returns an
 *   empty role, so ingest defaulted incomingRole to "Unknown". The role-aware
 *   primary lookup (findApplicationByCompanyAndRole) then searched for
 *   normalizedRole="unknown", matched none of the employer's real rows, the
 *   legacy fallback only fired for NULL-normalizedRole rows, and the
 *   senderDomain fallback missed (the rows had no stored domain). End result:
 *   a phantom "Unknown"-role row was created on track="career" even though the
 *   employer (Allied Universal) lived entirely on `side`.
 *
 * The fix: when the email is roleless AND a company match exists on ANY track,
 * merge into the most-recently-updated app for that employer — inheriting its
 * track — instead of creating a new career row.
 *
 * What we assert (replaying ingest's decision tree against the repo helpers,
 * same pattern as ingest-cross-track-dedup-smoke.ts):
 *   A. Roleless email at an employer that lives only on `side` → the decision
 *      tree merges into a side row (track inherited), not a new career row.
 *   B. A role-BEARING email for a genuinely new role at the same employer must
 *      NOT trigger the roleless merge — it falls through to create (new row).
 *   C. Source-level guard: the `!parsed.role` roleless branch is present.
 *
 *   DATABASE_URL="file:./dev.db" npx tsx scripts/tests/hermetic/ingest-roleless-merge-smoke.ts
 */
import { PrismaClient } from "@prisma/client";
import { randomBytes } from "crypto";
import { readFileSync } from "fs";
import { resolve } from "path";

import {
    createApplication,
    findApplicationByCompany,
    findApplicationByCompanyAndRole,
} from "@/lib/repositories/applications";

const prisma = new PrismaClient();
let passed = 0;
let failed = 0;
function check(name: string, condition: boolean, detail?: string) {
    if (condition) { console.log(`[PASS] ${name}`); passed++; }
    else { console.error(`[FAIL] ${name}${detail ? ` — ${detail}` : ""}`); failed++; }
}

/**
 * Faithful replay of the dedup chain in ingest.ts up to the create/update
 * decision. Mirrors the ordering: role-aware → (cross-track tie-breaker, n/a
 * here) → company-only (legacy NULL + roleless) → senderDomain. Returns the
 * row ingest would update, or null if it would create.
 */
async function resolveExisting(userId: string, company: string, role: string) {
    const incomingRole = role || "Unknown";
    let existingApp = await findApplicationByCompanyAndRole(userId, company, incomingRole);
    if (!existingApp) {
        const byCompany = await findApplicationByCompany(userId, company);
        if (byCompany && !byCompany.normalizedRole) {
            existingApp = byCompany; // legacy NULL-normalizedRole
        } else if (byCompany && !role) {
            existingApp = byCompany; // roleless merge
        }
    }
    return existingApp;
}

async function main() {
    const tag = randomBytes(4).toString("hex");
    const userId = `roleless-smoke-${tag}`;
    const createdIds: string[] = [];

    try {
        await prisma.user.create({
            data: { id: userId, email: `roleless-smoke-${tag}@example.invalid` },
        });

        // ─── Setup: the Allied Universal scenario — several SIDE-track rows ───
        // Each has a populated normalizedRole (post-backfill), so the legacy
        // NULL-normalizedRole fallback can NOT rescue a roleless email.
        const roles = [
            "Security Officer Part Time Museum Rover",
            "Security Officer Studio Patrol",
            "Security Officer Unarmed Driver Patrol",
        ];
        let lastId = "";
        for (const role of roles) {
            const app = await createApplication({
                userId,
                company: "Allied Universal",
                role,
                status: "INTERESTED",
                kind: "job",
                track: "side",
            });
            createdIds.push(app.id);
            lastId = app.id;
            check(
                `setup: side row "${role}" has normalizedRole populated`,
                !!app.normalizedRole,
                `got ${JSON.stringify(app.normalizedRole)}`,
            );
            await new Promise((r) => setTimeout(r, 5)); // make ordering deterministic
        }
        // lastId is the most-recently-updated Allied row → the merge target.

        // ─── Case A: roleless email merges into the most-recent side row ───
        // Pre-condition: the role-aware lookup with role="Unknown" misses.
        const rolelessPrimary = await findApplicationByCompanyAndRole(
            userId, "Allied Universal", "Unknown",
        );
        check(
            "case A: role-aware lookup for role='Unknown' misses all real rows",
            rolelessPrimary === null,
            `got ${JSON.stringify(rolelessPrimary?.id ?? null)}`,
        );

        const merged = await resolveExisting(userId, "Allied Universal", "");
        check(
            "case A: roleless email resolves to an existing row (no create)",
            merged !== null,
            `got null — would have created a new row`,
        );
        check(
            "case A: merged row is on the side track (inherited, not career)",
            merged?.track === "side",
            `got track=${merged?.track ?? "n/a"}`,
        );
        check(
            "case A: merged row is the most-recently-updated Allied app",
            merged?.id === lastId,
            `got id=${merged?.id ?? "null"} expected ${lastId}`,
        );

        // ─── Case B: a role-BEARING new role must NOT roleless-merge ───
        // A brand-new role the employer doesn't have yet should fall through to
        // create (returns null here), preserving the multi-role-per-company
        // design — roleless merge is gated on an empty role.
        const newRole = await resolveExisting(
            userId, "Allied Universal", "Front Desk Concierge",
        );
        check(
            "case B: role-bearing new role does NOT merge (would create)",
            newRole === null,
            `got id=${newRole?.id ?? "null"} (should be null → create path)`,
        );

        // ─── Case C: roleless email at a brand-new employer still creates ───
        const unknownCo = await resolveExisting(userId, "NeverHeardOfThem", "");
        check(
            "case C: roleless email at unknown employer resolves to null (create)",
            unknownCo === null,
            `got id=${unknownCo?.id ?? "null"}`,
        );

        // ─── Case D: source-level guard for the roleless branch ───
        const ingestSrc = readFileSync(
            resolve(__dirname, "../../../lib/applications/ingest.ts"),
            "utf8",
        );
        check(
            "case D: ingest source contains the `!parsed.role` roleless gate",
            /else if \(byCompany && !parsed\.role\)/.test(ingestSrc),
        );
        // The create branch must still hardcode track="career" (verified in
        // depth by ingest-cross-track-dedup-smoke; re-checked here so a refactor
        // that removes the literal trips this nearer test too).
        check(
            "case D: create branch still uses explicit track: \"career\"",
            /track:\s*"career"/.test(ingestSrc),
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
