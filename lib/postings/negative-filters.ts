// Negative filter compile + match for watchlist postings. Lives outside the
// route so the hermetic smoke can exercise it without an HTTP server.
//
// Filter source is the `Watchlist.negativeFilters` column — a JSON array of
// pattern strings. Patterns are matched case-insensitively against
// `${title}\n${snippet}\n${location}`. Invalid regexes are silently skipped
// so a bad pattern can't break the bell feed.
//
// Patterns whose SHAPE can backtrack catastrophically are skipped the same
// way — see `compilePattern`. That check is at the read boundary on purpose:
// this module is the only chokepoint the three compile sites share, and
// neither negative-filter read path passes through a Zod schema.
//
// Plain-keyword patterns (text containing no regex metacharacters) are
// auto-wrapped in `\b…\b` word boundaries so "armed" matches the word
// "armed" but NOT the inside of "unarmed". Patterns that contain any of
// `. * + ? ( ) [ ] { } ^ $ | \ /` are treated as user-authored regex and
// compiled verbatim — so escape hatches like `\bjr\b` or `senior.*` still
// work.

import { regexShapeRisk } from "@/lib/schemas/regex-guard";

// Compile-once cache keyed by the raw JSON string. Bounded in practice by the
// number of distinct filter strings observed, which equals the number of
// distinct watchlist configurations.
//
// Zero-dependency import only: this module is deliberately client-safe (see the
// note on `normalizeNegativeFilterForDedup`), so it pulls the shape scan from
// lib/schemas/regex-guard.ts — which imports nothing, not even zod — rather
// than from lib/schemas/watchlists.ts.
const regexCache = new Map<string, RegExp[]>();

const HAS_REGEX_METACHAR = /[.*+?()[\]{}^$|\\/]/;
const HAS_WORD_CHAR = /\w/;

function compilePattern(p: string): RegExp | null {
    // ReDoS bound at the READ boundary (2026-08-02). The write paths
    // (WatchlistPatchSchema.negativeFilters, SettingsPostSchema.negativeFilters)
    // now refuse catastrophic shapes, but that buys NOTHING here: unlike
    // `linkPattern` — whose read path runs through
    // `hydrateWatchlistConfig` → `WatchlistConfigSchema.parse` and so inherits
    // its schema for free — neither negative-filter read path touches Zod at
    // all. `lib/repositories/settings.ts:parseNegativeFilters` is a hand-rolled
    // JSON.parse + typeof filter, and `compileNegativeFilters` below is handed
    // the raw `Watchlist.negativeFilters` column string. So a row written
    // before the bound existed, restored from a backup, or hand-edited in
    // SQLite reaches `new RegExp` with nothing in between — and this function
    // is the only chokepoint all three compile sites share
    // (app/api/postings/route.ts, scheduler/jobs/job-watcher.ts,
    // scheduler/jobs/posting-digest.ts).
    //
    // Skipping matches this function's existing contract for a bad pattern —
    // return null, drop the filter, never break the feed — but it warns,
    // because a stored catastrophic pattern is a fact an operator wants to see
    // rather than a routine typo. Compiles are cached by the caller, so this
    // cannot spam the log ring buffer.
    const risk = regexShapeRisk(p);
    if (risk) {
        console.warn(
            `[negative-filters] skipping stored pattern ${JSON.stringify(p)} — ${risk}. ` +
            `It is not applied to any posting. Edit it in Settings or on the watchlist to clear this.`,
        );
        return null;
    }
    try {
        const isPlainKeyword = HAS_WORD_CHAR.test(p) && !HAS_REGEX_METACHAR.test(p);
        const source = isPlainKeyword ? `\\b${p}\\b` : p;
        return new RegExp(source, "i");
    } catch {
        return null;
    }
}

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
        const re = compilePattern(p);
        if (re) out.push(re);
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

// Normalization for dedup ONLY — never used to mutate stored patterns.
// Folds away differences that are visual-only between two filter entries
// (case, whitespace, and "safe" trailing/inline punctuation) so that "Sr"
// and "Sr." don't both land on the list. Regex metacharacters are
// preserved: a user typing `Sr\.` (literal "Sr.") vs `Sr` (word "Sr") is
// expressing distinct intent, so collapsing them would be wrong. We only
// strip an UNESCAPED literal period; a `\.` survives normalization.
// Punctuation kept harmless to strip: `,;:!?'"`. Punctuation left alone
// (regex metachars or grouping): `()[]{}*+?\|^$`.
//
// Lives in this client-safe module (no prisma imports) so WatchlistsCard
// and other client components can dedup without dragging the server
// runtime into the browser bundle.
export function normalizeNegativeFilterForDedup(s: string): string {
    let out = "";
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        // Preserve any `\X` escape pair as-is so `Sr\.` stays distinct from
        // `Sr.`. Skip the following char regardless of what it is.
        if (ch === "\\" && i + 1 < s.length) {
            out += ch + s[i + 1];
            i++;
            continue;
        }
        // Strip standalone literal period and other visual-only punctuation.
        if (ch === "." || ch === "," || ch === ";" || ch === ":" || ch === "!" || ch === "?" || ch === "'" || ch === '"') {
            continue;
        }
        out += ch;
    }
    return out.toLowerCase().replace(/\s+/g, " ").trim();
}
