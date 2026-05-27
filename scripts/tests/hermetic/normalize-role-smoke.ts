/**
 * Hermetic smoke for lib/applications/normalize-role.ts (2026-05-27).
 *
 * Rule B (operator-chosen): keep parens content as additional tokens, strip
 * employment-modality words (part time, full time, remote, hybrid, intern,
 * contract, …), preserve substantive modifiers (senior, junior, lead, …).
 *
 *   npx tsx scripts/tests/hermetic/normalize-role-smoke.ts
 *
 * Pure function — no DB, no Prisma, no env needed.
 */
import { normalizeRoleName } from "@/lib/applications/normalize-role";

let passed = 0;
let failed = 0;
function eq(name: string, got: string, want: string) {
    if (got === want) { console.log(`[PASS] ${name}`); passed++; }
    else { console.error(`[FAIL] ${name} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); failed++; }
}

// Basic shape
eq("empty string → empty", normalizeRoleName(""), "");
eq("whitespace-only → empty", normalizeRoleName("   \t  "), "");
eq("simple lower + trim", normalizeRoleName("  Security Officer "), "security officer");

// The bug case: same company, two distinct roles must normalize differently.
// Posting title 1: "Security Officer Part Time Museum Rover"
// Posting title 2: "Security Officer Mall Patrol"
eq("museum rover preserves identity", normalizeRoleName("Security Officer Part Time Museum Rover"), "security officer museum rover");
eq("mall patrol preserves identity", normalizeRoleName("Security Officer Mall Patrol"), "security officer mall patrol");

// Rule B: parens become token separators, contents stay as tokens.
eq("parens content kept as tokens", normalizeRoleName("Part-Time Security Officer (Museum)"), "security officer museum");
eq("parens distinguish sites", normalizeRoleName("Security Officer (Mall Patrol)"), "security officer mall patrol");
eq("empty parens collapse", normalizeRoleName("Security Officer ()"), "security officer");
eq("parens with location keyword", normalizeRoleName("Engineer (LAX)"), "engineer lax");

// Modality stripping
eq("PT abbreviation stripped", normalizeRoleName("PT Security Officer"), "security officer");
eq("Full Time stripped", normalizeRoleName("Full Time Software Engineer"), "software engineer");
eq("Remote stripped", normalizeRoleName("Software Engineer (Remote)"), "software engineer");
eq("Intern stripped", normalizeRoleName("Intern - Software Engineer"), "software engineer");
eq("Contract stripped", normalizeRoleName("Contract Software Engineer"), "software engineer");

// Substantive modifiers preserved (these CHANGE the role identity)
eq("senior preserved", normalizeRoleName("Senior Software Engineer"), "senior software engineer");
eq("staff preserved", normalizeRoleName("Staff Engineer"), "staff engineer");
eq("principal preserved", normalizeRoleName("Principal Architect"), "principal architect");

// Punctuation
eq("commas split", normalizeRoleName("Software Engineer, Backend"), "software engineer backend");
eq("slashes split", normalizeRoleName("DevOps/SRE"), "devops sre");
eq("ampersand split", normalizeRoleName("Sales & Marketing"), "sales marketing");
eq("emdash split", normalizeRoleName("Engineer — Backend"), "engineer backend");

// Idempotency
{
    const inputs = [
        "Security Officer Part Time Museum Rover",
        "Part-Time Security Officer (Museum)",
        "Senior Software Engineer, Backend (Remote)",
    ];
    let allIdempotent = true;
    for (const input of inputs) {
        const once = normalizeRoleName(input);
        const twice = normalizeRoleName(once);
        if (once !== twice) {
            allIdempotent = false;
            console.error(`  not idempotent: ${JSON.stringify(input)} → ${JSON.stringify(once)} → ${JSON.stringify(twice)}`);
        }
    }
    if (allIdempotent) { console.log("[PASS] idempotent: normalize(normalize(x)) === normalize(x)"); passed++; }
    else { console.error("[FAIL] idempotent check"); failed++; }
}

// All-noise input → empty
eq("all-noise input → empty", normalizeRoleName("Part Time Full Time Remote Contract"), "");

console.log(`\n${passed}/${passed + failed} steps passed`);
if (failed > 0) process.exit(1);
