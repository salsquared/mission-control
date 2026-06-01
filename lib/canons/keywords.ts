// Canon keyword text → flat term array.
//
// A canon's `keywords` column is raw user-provided TEXT (§6 Q3): a plain
// comma-separated list the user types and sees (e.g. `math tutor, SAT prep,
// test prep`) — for a side canon copied off the feeding watchlist's keyword
// string, for a career canon whatever the user typed. The boolean OR / quoting
// LinkedIn/Indeed want is added downstream at fetch time only
// (lib/watchlists/keyword-query.ts), never stored here. The resume pipeline
// wants a `string[]`, so we split on comma / semicolon / newline list
// separators — plus the legacy uppercase boolean OR operator, so pre-migration
// strings still tokenize — strip wrapping quotes and parens, trim, drop
// empties, and case-insensitively dedupe.
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
