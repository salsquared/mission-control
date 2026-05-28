/**
 * Hermetic smoke for the profile-synthesize skip-guard (lib/profile/synthesize.ts).
 *
 * The synthesis pass is the single most expensive LLM call in the app
 * (MODEL_FLASH, 32k output, 80 KB input). Its job is cross-FILE consolidation +
 * existing-profile reconciliation — neither of which exists for a single resume
 * uploaded into an empty profile. `canSkipSynthesis` detects that case so the
 * route returns the lone extraction verbatim with NO Flash call.
 *
 * Asserts the predicate's truth table, and that synthesizeMasterResume actually
 * short-circuits (returns the draft tree by identity, no network) on the skip
 * path — which it could only do via the guard, since there's no Gemini key in
 * the hermetic env.
 *
 *   npx tsx scripts/tests/hermetic/synthesize-skip-guard-smoke.ts
 */

import { canSkipSynthesis, synthesizeMasterResume } from "@/lib/profile/synthesize";
import type { ExtractedProfile } from "@/lib/profile/import-llm";
import type { ExistingProfileForMerge } from "@/lib/profile/merge";

let passes = 0;
let fails = 0;
function pass(msg: string) { console.log(`[PASS] ${msg}`); passes++; }
function fail(msg: string, detail?: unknown) { console.error(`[FAIL] ${msg}`, detail ?? ""); fails++; }

const EMPTY_PROFILE: ExistingProfileForMerge = {
    headline: null, location: null, email: null, phone: null, links: null,
    workRoles: [], projects: [], education: [],
};

// Header-only existing profile (no entities) — still "empty" for skip purposes.
const HEADER_ONLY_PROFILE: ExistingProfileForMerge = {
    headline: "Engineer", location: "LA", email: "x@y.com", phone: null,
    links: [{ label: "GitHub", url: "https://github.com/x" }],
    workRoles: [], projects: [], education: [],
};

const NONEMPTY_PROFILE: ExistingProfileForMerge = {
    headline: null, location: null, email: null, phone: null, links: null,
    workRoles: [{
        id: "wr1", company: "Acme", title: "Engineer", location: null,
        startDate: null, endDate: null, bullets: [],
    }],
    projects: [], education: [],
};

function tree(name: string): ExtractedProfile {
    return {
        header: { headline: name, location: null, email: null, phone: null, links: null },
        workRoles: [{
            company: "Acme", title: "Engineer", location: null,
            startDate: null, endDate: null, bullets: ["Built things"],
        }],
        projects: [],
        education: [],
    };
}

function draft(name: string) { return { filename: `${name}.pdf`, tree: tree(name) }; }

function testTruthTable() {
    // Skip: exactly one draft into an empty profile.
    if (canSkipSynthesis(EMPTY_PROFILE, [draft("a")]) !== true) fail("truth: single draft + empty profile should skip");
    else pass("truth: single draft + empty profile → skip");

    // Skip: header-only existing profile still counts as empty (no entities).
    if (canSkipSynthesis(HEADER_ONLY_PROFILE, [draft("a")]) !== true) fail("truth: single draft + header-only profile should skip");
    else pass("truth: single draft + header-only profile → skip (entities empty)");

    // No skip: two drafts → cross-file dedup is synthesize's core job.
    if (canSkipSynthesis(EMPTY_PROFILE, [draft("a"), draft("b")]) !== false) fail("truth: 2 drafts should NOT skip");
    else pass("truth: 2 drafts → run synthesis (cross-file dedup)");

    // No skip: single draft but the profile already has entities.
    if (canSkipSynthesis(NONEMPTY_PROFILE, [draft("a")]) !== false) fail("truth: single draft + non-empty profile should NOT skip");
    else pass("truth: single draft + non-empty profile → run synthesis (reconcile)");

    // No skip: zero drafts (degenerate — route guards this earlier, but the
    // predicate must not claim a skip when there's nothing to return).
    if (canSkipSynthesis(EMPTY_PROFILE, []) !== false) fail("truth: zero drafts should NOT skip");
    else pass("truth: zero drafts → no skip");
}

async function testShortCircuitReturnsDraft() {
    const d = draft("solo");
    // No GOOGLE/GEMINI key in the hermetic env, so if this did NOT short-circuit
    // it would throw on the chatJSON call. A clean identity return proves the
    // skip path ran.
    let result: ExtractedProfile;
    try {
        result = await synthesizeMasterResume(EMPTY_PROFILE, [d]);
    } catch (e) {
        fail("short-circuit: synthesizeMasterResume threw instead of skipping the Flash call", (e as Error).message);
        return;
    }
    if (result !== d.tree) fail("short-circuit: expected the draft tree returned by identity (verbatim)", result);
    else pass("short-circuit: single-file + empty profile returns extraction verbatim, no Flash call");
}

async function main() {
    testTruthTable();
    await testShortCircuitReturnsDraft();
    console.log(`\n${passes}/${passes + fails} steps passed`);
    if (fails > 0) {
        console.error(`${fails} failure(s).`);
        process.exit(1);
    }
    console.log("All checks passed.");
}

main().catch(e => { console.error("Smoke crashed:", e); process.exit(2); });
