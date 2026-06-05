/**
 * Hermetic smoke for the lenient role-subset dedup matcher
 * (lib/applications/match-role-subset.ts), added 2026-06-04 after an Astranis
 * application-confirmation email mis-merged onto a Muon Space card.
 *
 * Root cause it guards: the strict (company, role) dedup compares the FULL
 * normalizedRole, so a confirmation email that drops a term suffix the tracked
 * posting carried — "Software Engineer Intern - Data Platform (Summer 2026)"
 * (tracked) vs the email's bare "Software Engineer Intern - Data Platform" —
 * misses the existing card. findUniqueRoleSuperset merges it into the unique
 * role it degrades from, and DECLINES when the subset is ambiguous.
 *
 * Pure-function test — no DB, no LLM, no network.
 *
 *   npx tsx scripts/tests/hermetic/match-role-subset-smoke.ts
 */
import { findUniqueRoleSuperset } from "@/lib/applications/match-role-subset";
import { normalizeRoleName } from "@/lib/applications/normalize-role";

let passed = 0;
let failed = 0;
function check(name: string, condition: boolean, detail?: string) {
    if (condition) { console.log(`[PASS] ${name}`); passed++; }
    else { console.error(`[FAIL] ${name}${detail ? ` — ${detail}` : ""}`); failed++; }
}

// Candidates carry only what the matcher reads: a precomputed normalizedRole,
// plus an id so we can assert WHICH row matched.
function cand(id: string, role: string) {
    return { id, normalizedRole: normalizeRoleName(role) };
}

function main() {
    // ─── The Astranis repro ─────────────────────────────────────────────────
    // Tracked posting kept the "(Summer 2026)" term; the confirmation email
    // dropped it. Exactly one Astranis card exists → unique superset → match.
    {
        const astranis = [cand(
            "astranis-1",
            "Software Engineer Intern - Data Platform (Summer 2026)",
        )];
        const r = findUniqueRoleSuperset(
            "Software Engineer Intern - Data Platform", // email role, no season
            astranis,
        );
        check("Astranis: drifted email role merges into the tracked card",
            r.match?.id === "astranis-1", `got ${JSON.stringify(r)}`);
        check("Astranis: supersetCount is exactly 1", r.supersetCount === 1);
    }

    // ─── Hermeus ambiguity guard ────────────────────────────────────────────
    // A generic "Software Engineering Intern" is a subset of FOUR distinct
    // Hermeus specializations → ambiguous → MUST decline (no guess), so it
    // falls through to senderDomain/create instead of corrupting a sibling.
    {
        const hermeus = [
            cand("h-modsim", "Software Engineering Intern (Modeling & Simulation) - Fall 2026"),
            cand("h-hmi",    "Software Engineering Intern (HMI) - Fall 2026"),
            cand("h-hil",    "Software Engineering Intern (HIL) - Fall 2026"),
            cand("h-flight", "Flight Software Engineering Intern - Fall 2026"),
            cand("h-prop",   "Propulsion Engineer Intern - Fall 2026"),
        ];
        const generic = findUniqueRoleSuperset("Software Engineering Intern", hermeus);
        check("Hermeus: generic SWE role is ambiguous → no match",
            generic.match === null, `got ${generic.match?.id}`);
        check("Hermeus: ambiguous count > 1 (declined, not zero)",
            generic.supersetCount > 1, `count=${generic.supersetCount}`);

        // A SPECIFIC drifted email (drops only the season) still resolves to
        // its one true sibling among the same five.
        const specific = findUniqueRoleSuperset(
            "Software Engineering Intern (Modeling & Simulation)", hermeus);
        check("Hermeus: specialization-bearing email matches its one sibling",
            specific.match?.id === "h-modsim", `got ${specific.match?.id}`);
    }

    // ─── Exact equality never matches here ──────────────────────────────────
    // An exact-equal role is handled by the strict primary lookup upstream;
    // STRICT superset means equality must NOT be claimed by this matcher.
    {
        const r = findUniqueRoleSuperset(
            "Software Engineer Intern - Data Platform (Summer 2026)",
            [cand("x", "Software Engineer Intern - Data Platform (Summer 2026)")],
        );
        check("exact-equal role is NOT a strict superset (no match)",
            r.match === null && r.supersetCount === 0, `got ${JSON.stringify(r)}`);
    }

    // ─── Reverse drift is NOT matched (one-way by design) ───────────────────
    // Incoming role has MORE tokens than the stored one → incoming ⊄ stored.
    {
        const r = findUniqueRoleSuperset(
            "Software Engineer Intern - Data Platform (Summer 2026)", // longer
            [cand("y", "Software Engineer Intern - Data Platform")],   // shorter stored
        );
        check("reverse drift (incoming longer) does not match",
            r.match === null, `got ${r.match?.id}`);
    }

    // ─── Empty / roleless incoming declines ─────────────────────────────────
    {
        // "Intern" is pure noise → normalizes to "" → decline (roleless case is
        // owned by the company-only branch in ingest.ts).
        const r = findUniqueRoleSuperset("Intern", [cand("z", "Software Engineer Intern")]);
        check("roleless/empty incoming role declines (supersetCount 0)",
            r.match === null && r.supersetCount === 0, `got ${JSON.stringify(r)}`);
    }

    // ─── No candidates → no match, no throw ─────────────────────────────────
    {
        const r = findUniqueRoleSuperset("Software Engineer", []);
        check("empty candidate list yields no match", r.match === null && r.supersetCount === 0);
    }

    // ─── Disjoint roles don't match ─────────────────────────────────────────
    {
        const r = findUniqueRoleSuperset(
            "Mechanical Engineer",
            [cand("a", "Software Engineer Intern - Data Platform (Summer 2026)")],
        );
        check("disjoint incoming role (no shared tokens) does not match",
            r.match === null, `got ${r.match?.id}`);
    }

    console.log(`\n${passed}/${passed + failed} steps passed`);
    if (failed > 0) process.exit(1);
    console.log("All checks passed.");
}

main();
