// Watchlist/canon keyword input is a plain comma-separated list the user types
// and sees — e.g. `AI trainer, data annotator, prompt engineer`. No boolean
// operators, no quotes. This is the ONE place those get added.
//
// LinkedIn/Indeed's guest search bars treat a bare comma list as an implicit
// AND/relevance match (NARROWS — "jobs mentioning all these words"), not OR
// (BROADENS — "jobs matching any of these phrases"). To "catch as much as
// possible" we expand the list into the boolean OR query those bars actually
// want, quoting multi-word terms so each phrase stays grouped under its own OR
// branch (`"AI trainer" OR "data annotator" OR prompt`). Single-word terms are
// left bare — no quoting needed.
//
// Tolerant + idempotent by reusing splitCanonKeywords, which already splits on
// OR / comma / semicolon / newline and strips wrapping quotes: a legacy boolean
// string round-trips to the same query, so un-migrated rows keep working. The
// fetchers call this at request time — storage and the UI stay list-form, never
// OR/quotes.
import { splitCanonKeywords } from "@/lib/canons/keywords";

export function buildSearchQuery(raw: string): string {
    return splitCanonKeywords(raw)
        .map((term) => (/\s/.test(term) ? `"${term}"` : term))
        .join(" OR ");
}
