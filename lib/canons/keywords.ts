// Canon keyword text → flat term array.
//
// A canon's `keywords` column is raw user-provided TEXT (§6 Q3): for a side
// canon it's copied off the feeding watchlist's keyword string (a boolean
// OR-query like `"math tutor" OR "SAT prep" OR test prep`); for a career canon
// it's whatever the user typed. The resume pipeline wants a `string[]`, so we
// split on the boolean OR operator (uppercase, the LinkedIn/Indeed convention)
// plus comma / semicolon / newline list separators, strip wrapping quotes and
// parens, trim, drop empties, and case-insensitively dedupe.
//
// No weights in v1 (§6 Q6) — `scoreBullet` defaults missing importance to 1, so
// a flat list selects fine; weighting is a deferred refinement.
export function splitCanonKeywords(text: string): string[] {
    if (!text) return [];
    const parts = text
        // Uppercase boolean OR (with surrounding whitespace) is the operator;
        // lowercase "or" inside a phrase ("search or rescue") is left intact.
        .split(/\s+OR\s+|[,;\n]+/)
        // Strip wrapping quotes / parens / whitespace a boolean query carries.
        .map((s) => s.replace(/^["'()\s]+|["'()\s]+$/g, "").trim())
        .filter((s) => s.length > 0);

    const seen = new Set<string>();
    const out: string[] = [];
    for (const p of parts) {
        const key = p.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(p);
    }
    return out;
}
