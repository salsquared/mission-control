/**
 * PB-15: hermetic smoke for the employment-type normalizer + title heuristic.
 * No network, no DB. Wire into pre-push.
 */
import { normalizeEmploymentType, inferEmploymentTypeFromTitle, pickEmploymentType } from "@/lib/fetchers/employment-type";

let passed = 0;
let failed = 0;
function check(name: string, condition: boolean, detail?: string) {
    if (condition) { console.log(`[PASS] ${name}`); passed++; }
    else { console.error(`[FAIL] ${name}${detail ? ` — ${detail}` : ""}`); failed++; }
}

// ─── normalizeEmploymentType ────────────────────────────────────────────────
check("null → null",        normalizeEmploymentType(null) === null);
check("undefined → null",   normalizeEmploymentType(undefined) === null);
check("empty → null",       normalizeEmploymentType("") === null);
check("'Full-time' → full-time",      normalizeEmploymentType("Full-time") === "full-time");
check("'FULL_TIME' → full-time",      normalizeEmploymentType("FULL_TIME") === "full-time");
check("'FullTime' → full-time",       normalizeEmploymentType("FullTime") === "full-time");
check("'Permanent' → full-time",      normalizeEmploymentType("Permanent") === "full-time");
check("'Intern' → internship",        normalizeEmploymentType("Intern") === "internship");
check("'Internship' → internship",    normalizeEmploymentType("Internship") === "internship");
check("'Co-op' → internship",         normalizeEmploymentType("Co-op") === "internship");
check("'Contract' → contract",        normalizeEmploymentType("Contract") === "contract");
check("'Contractor' → contract",      normalizeEmploymentType("Contractor") === "contract");
check("'Freelance' → contract",       normalizeEmploymentType("Freelance") === "contract");
check("'Part-time' → part-time",      normalizeEmploymentType("Part-time") === "part-time");
check("'Temporary' → temporary",      normalizeEmploymentType("Temporary") === "temporary");
check("'Seasonal' → temporary",       normalizeEmploymentType("Seasonal") === "temporary");
check("'gibberish' → null",           normalizeEmploymentType("gibberish") === null);
// Defense against substring-match false positives — "International" must not
// classify as "internship" (the old substring-check version did).
check("'International' → null",       normalizeEmploymentType("International") === null);
check("'Contracts dept' → null",      normalizeEmploymentType("Contracts dept") === null);
check("'Fulltime ' (trailing space) → full-time",  normalizeEmploymentType("Fulltime ") === "full-time");

// ─── inferEmploymentTypeFromTitle ───────────────────────────────────────────
check("'Software Engineer' → null",                       inferEmploymentTypeFromTitle("Software Engineer") === null);
check("'Avionics Intern' → internship",                   inferEmploymentTypeFromTitle("Avionics Intern") === "internship");
check("'Summer Internship 2026' → internship",            inferEmploymentTypeFromTitle("Summer Internship 2026") === "internship");
check("'Engineering Co-op' → internship",                 inferEmploymentTypeFromTitle("Engineering Co-op") === "internship");
check("'Contract Engineer' → contract",                   inferEmploymentTypeFromTitle("Contract Engineer") === "contract");
check("'Senior Engineer (Part-time)' → part-time",        inferEmploymentTypeFromTitle("Senior Engineer (Part-time)") === "part-time");
check("'Temporary QA Tester' → temporary",                inferEmploymentTypeFromTitle("Temporary QA Tester") === "temporary");
check("'Full-time Software Engineer' → full-time",        inferEmploymentTypeFromTitle("Full-time Software Engineer") === "full-time");
check("Specificity: 'Full-time Intern' → internship",     inferEmploymentTypeFromTitle("Full-time Intern") === "internship");
// No false positives:
check("'International Engineer' has 'intern' substring → null",  inferEmploymentTypeFromTitle("International Engineer") === null);
check("'Contractor's lead' has 'contract' substring → contract", inferEmploymentTypeFromTitle("Contractor's lead") === "contract");
// (this is fine — "contractor" is a real keyword. The dangerous-substring case is "intern" in "international".)

// Role-disqualifier rule: permanent-role keywords near "contract"/"intern" must NOT classify as the keyword.
check("'Vendor and Contract Manager' → null (disqualifier)",     inferEmploymentTypeFromTitle("Vendor and Contract Manager") === null);
check("'Contract Coordinator' → null (disqualifier)",            inferEmploymentTypeFromTitle("Contract Coordinator") === null);
check("'Intern Program Manager' → null (disqualifier)",          inferEmploymentTypeFromTitle("Intern Program Manager") === null);

// Bracketed markers override disqualifiers (they're the strongest signal):
check("'Recruiting Coordinator [contract]' → contract (bracket wins)", inferEmploymentTypeFromTitle("Recruiting Coordinator [contract]") === "contract");
check("'Software Engineer (Internship)' → internship (paren wins)",   inferEmploymentTypeFromTitle("Software Engineer (Internship)") === "internship");

// Fellowship policy (decided 2026-05-19): structured ATS "Fellowship" values
// land in full-time (modern lab fellowships are paid 6-12mo W-2 roles, not
// student internships). Tier-A's title regex no longer claims a bare "Fellow"
// / "Fellows Program" as internship — those abstain (null) and Tier-B
// decides. A summer-cohort fellowship still hits the season+year regex here
// and lands in internship before Tier-B sees it.
check("'Anthropic Fellow' → null (title heuristic abstains)",       inferEmploymentTypeFromTitle("Anthropic Fellow") === null);
check("'Research Fellow' → null (title heuristic abstains)",        inferEmploymentTypeFromTitle("Research Fellow") === null);
check("'Anthropic Fellows Program' → null",                         inferEmploymentTypeFromTitle("Anthropic Fellows Program") === null);
check("'Summer 2026 Research Fellow' → internship (season+year)",   inferEmploymentTypeFromTitle("Summer 2026 Research Fellow") === "internship");
// Structured ATS string → full-time (modern lab fellowship policy):
check("normalize 'Fellowship' → full-time",                         normalizeEmploymentType("Fellowship") === "full-time");
check("normalize 'Fellow' → full-time",                             normalizeEmploymentType("Fellow") === "full-time");

// ─── pickEmploymentType ────────────────────────────────────────────────────
check("structured wins over title",                            pickEmploymentType("FullTime", "Intern Engineer") === "full-time");
check("falls back to title when structured is null",           pickEmploymentType(null, "Software Engineering Intern") === "internship");
check("both null → null",                                      pickEmploymentType(null, "Software Engineer") === null);

console.log(`\n${passed}/${passed + failed} steps passed`);
if (failed > 0) process.exit(1);
console.log("All checks passed.");
