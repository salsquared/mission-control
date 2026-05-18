/**
 * PB-15: normalize employment type strings across ATSes so the new-postings
 * filter UI has a single small enum to render chips for.
 *
 * Two callers:
 *   - `normalizeEmploymentType(raw)`: pass values straight from the ATS
 *     payload (Lever's `categories.commitment`, Ashby's `employmentType`,
 *     LinkedIn's benefits text). Loose matching by substring.
 *   - `inferEmploymentTypeFromTitle(title)`: fallback for ATSes that don't
 *     expose employment type at all (Greenhouse, Workday, careers-page).
 *     Title-keyword heuristic only — won't fire for ambiguous postings.
 *
 * Returns null when nothing matches — never fabricate. The UI shows
 * "Unspecified" for null and includes them by default in any filter.
 */
export type EmploymentType = "full-time" | "part-time" | "internship" | "contract" | "temporary";

export const EMPLOYMENT_TYPES: readonly EmploymentType[] = [
    "full-time",
    "part-time",
    "internship",
    "contract",
    "temporary",
] as const;

/**
 * Normalize an ATS-supplied employment-type string. Strips separators
 * (`_`, `-`, whitespace) then matches against a fixed lookup so we don't
 * fall into the "International" → "internship" trap that a substring check
 * would create. Covers the real values Lever / Ashby / LinkedIn return.
 */
const EMPLOYMENT_TYPE_LOOKUP: Record<string, EmploymentType> = {
    fulltime: "full-time",
    permanent: "full-time",
    regular: "full-time",
    parttime: "part-time",
    intern: "internship",
    interns: "internship",
    internship: "internship",
    internships: "internship",
    coop: "internship",
    apprentice: "internship",
    apprenticeship: "internship",
    fellow: "internship",
    fellowship: "internship",
    contract: "contract",
    contracts: "contract",
    contractor: "contract",
    contractors: "contract",
    freelance: "contract",
    freelancer: "contract",
    temporary: "temporary",
    temp: "temporary",
    seasonal: "temporary",
    fixedterm: "temporary",
};

export function normalizeEmploymentType(raw: string | null | undefined): EmploymentType | null {
    if (!raw) return null;
    const s = raw.toLowerCase().replace(/[_\-\s]+/g, "");
    return EMPLOYMENT_TYPE_LOOKUP[s] ?? null;
}

/**
 * Title-keyword inference. Designed to be conservative — only fires when a
 * job title contains an unambiguous marker. Picks the most-specific match
 * (internship beats full-time when both appear, e.g. "Full-time Intern").
 *
 * Two-pass design:
 *   1. Bracketed / parenthesized markers ("[Contract]", "(Internship)") are
 *      the strongest signal and bypass the disqualifier. Job boards commonly
 *      tag employment type this way.
 *   2. Otherwise: standard word-boundary check, BUT when the keyword is
 *      "contract" / "intern", disqualify titles that pair it with a permanent
 *      role word ("Manager", "Director", "Coordinator", "Specialist",
 *      "Administrator", "Officer", "Negotiator", "Lawyer", "Analyst") —
 *      "Contract Manager" is a permanent role doing contract work, not a
 *      contract employment. Backfill against real data on 2026-05-17
 *      surfaced "Vendor and Contract Manager" as a false positive without
 *      this disqualifier.
 */
const ROLE_DISQUALIFIERS = /\b(manager|director|coordinator|specialist|administrator|officer|negotiator|attorney|lawyer|analyst|advisor|consultant)\b/i;

function bracketedHit(title: string): EmploymentType | null {
    const m = title.match(/[[(](intern(?:ship)?s?|co-?op|contract(?:or)?|freelance|part[-\s]?time|temp(?:orary)?|seasonal|full[-\s]?time)[\])]/i);
    if (!m) return null;
    const tok = m[1].toLowerCase().replace(/\s+/g, "").replace(/-/g, "");
    if (tok.startsWith("intern") || tok === "coop") return "internship";
    if (tok.startsWith("contract") || tok === "freelance") return "contract";
    if (tok === "parttime") return "part-time";
    if (tok.startsWith("temp") || tok === "seasonal") return "temporary";
    if (tok === "fulltime") return "full-time";
    return null;
}

export function inferEmploymentTypeFromTitle(title: string): EmploymentType | null {
    const bracketed = bracketedHit(title);
    if (bracketed) return bracketed;

    const s = title.toLowerCase();
    // "Fellows Program" / "Anthropic Fellows" is an internship-class role
    // (cohort-based, fixed-term, mentor-supervised). Match standalone too:
    // "AI Safety Fellow", "Research Fellow".
    if (/\b(intern(ship)?s?|co-?op|apprentice(ship)?|fellows?(\s+program)?)\b/.test(s)) {
        if (ROLE_DISQUALIFIERS.test(s)) return null;
        return "internship";
    }
    // "Summer 2026 SWE", "Fall 2026 Quant" — season + year strongly implies
    // an internship class. Year window kept open-ended (\d{4}) so this stays
    // forward-compatible.
    if (/\b(spring|summer|fall|autumn|winter)\s+20\d{2}\b/.test(s)) return "internship";
    if (/\b(contract(or)?|freelance)\b/.test(s)) {
        if (ROLE_DISQUALIFIERS.test(s)) return null;
        return "contract";
    }
    if (/\bpart[-\s]?time\b/.test(s)) return "part-time";
    if (/\b(temp(orary)?|seasonal)\b/.test(s)) return "temporary";
    if (/\bfull[-\s]?time\b/.test(s)) return "full-time";
    return null;
}

/**
 * Convenience: try the structured field first, fall back to the title.
 * Useful for fetchers whose ATS sometimes does and sometimes doesn't include
 * the employment-type field on a posting.
 */
export function pickEmploymentType(structured: string | null | undefined, title: string): EmploymentType | null {
    return normalizeEmploymentType(structured) ?? inferEmploymentTypeFromTitle(title);
}
