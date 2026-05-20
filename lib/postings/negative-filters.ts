// Negative filter compile + match for watchlist postings. Lives outside the
// route so the hermetic smoke can exercise it without an HTTP server.
//
// Filter source is the `Watchlist.negativeFilters` column — a JSON array of
// regex pattern strings. Patterns are matched case-insensitively against
// `${title}\n${snippet}\n${location}`. Invalid regexes are silently skipped
// so a bad pattern can't break the bell feed.

// Compile-once cache keyed by the raw JSON string. Bounded in practice by the
// number of distinct filter strings observed, which equals the number of
// distinct watchlist configurations.
const regexCache = new Map<string, RegExp[]>();

export function compileNegativeFilters(json: string | null): RegExp[] {
    if (!json) return [];
    const cached = regexCache.get(json);
    if (cached) return cached;
    let parsed: unknown;
    try { parsed = JSON.parse(json); } catch { return []; }
    if (!Array.isArray(parsed)) return [];
    const out: RegExp[] = [];
    for (const p of parsed) {
        if (typeof p !== "string" || p.length === 0) continue;
        try { out.push(new RegExp(p, "i")); } catch { /* invalid pattern — skip */ }
    }
    regexCache.set(json, out);
    return out;
}

// Compile a plain pattern array. Used for the cross-watchlist global filter
// stored on GlobalSetting.globalNegativeFilters. Routes through the same
// cache by JSON-stringifying the input so identical pattern sets share regex
// instances.
export function compileNegativeFiltersFromArray(patterns: string[]): RegExp[] {
    if (patterns.length === 0) return [];
    return compileNegativeFilters(JSON.stringify(patterns));
}

export function matchesNegativeFilters(
    row: { title: string; snippet: string | null; location: string | null },
    regexes: RegExp[],
): boolean {
    if (regexes.length === 0) return false;
    const haystack = `${row.title}\n${row.snippet ?? ""}\n${row.location ?? ""}`;
    return regexes.some(re => re.test(haystack));
}

// Test-only: blow the cache so a smoke can re-test with mutated filters under
// the same JSON identity.
export function _resetNegativeFilterCache() {
    regexCache.clear();
}
