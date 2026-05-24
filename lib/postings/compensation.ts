// Story S5.9 — compensation parser. Pure function over a posting's snippet
// (or whatever free-text the fetcher gave us) → a structured comp range or
// null when nothing recognisable was found.
//
// Scope (V1):
//   - USD only. We don't have postings outside the US in the watchlist
//     fleet yet; when we do, currency inference goes through the symbol
//     ($/€/£/¥).
//   - Recognises ranges ("$120k - $150k", "$120,000 to $150,000") and
//     single anchored values ("up to $200k", "$60/hr"). When only one
//     side of the range is present, both `min` and `max` get the same
//     value so sorting still works.
//   - Cadence comes from the explicit suffix ("/hr", "per year", "annually")
//     or falls back to NULL — the UI defaults to "year" on display when a
//     range is present but cadence is unknown (the dominant case for
//     white-collar postings).
//
// Out of scope: equity / RSU language, location adjustments, signing bonus.
// The user can read those in the snippet itself; structured storage of
// equity is messy enough that "show me roles paying ≥ $X" is the only
// sort surface that matters first.

export type Cadence = "hour" | "day" | "week" | "month" | "year";

export interface ParsedCompensation {
    min: number;
    max: number;
    currency: string;       // ISO-4217, "USD" for now
    cadence: Cadence | null;
}

// Each alternative carries its own boundaries — putting one `\b` at the start
// of the outer group fails for `/year`/`/hr` style suffixes (the position
// right before `/` is rarely a word boundary in real snippets like
// "$120 / year" because there's a space on both sides).
const CADENCE_PATTERNS: Array<{ regex: RegExp; cadence: Cadence }> = [
    { regex: /(?:\bper\s*hour\b|\/\s*hour\b|\/\s*hr\b|\bhourly\b)/i, cadence: "hour" },
    { regex: /(?:\bper\s*day\b|\/\s*day\b|\bdaily\b)/i, cadence: "day" },
    { regex: /(?:\bper\s*week\b|\/\s*week\b|\bweekly\b)/i, cadence: "week" },
    { regex: /(?:\bper\s*month\b|\/\s*month\b|\bmonthly\b)/i, cadence: "month" },
    { regex: /(?:\bper\s*year\b|\/\s*year\b|\bannually\b|\bannual\b|\bper\s*annum\b|\bp\.?a\.?\b|\byearly\b)/i, cadence: "year" },
];

function detectCadence(text: string): Cadence | null {
    for (const { regex, cadence } of CADENCE_PATTERNS) {
        if (regex.test(text)) return cadence;
    }
    return null;
}

// Parse "120k" → 120_000, "120,000" → 120_000, "120000" → 120_000, "200" → 200.
// Returns null on any garbage (e.g. "abc") rather than throwing.
function parseAmount(raw: string): number | null {
    if (!raw) return null;
    const cleaned = raw.replace(/,/g, "").trim();
    // Match optional decimal + optional k/m suffix. We do NOT support "m" for
    // hourly contexts (no realistic posting pays $1m/hr), but for total comp
    // a "$1.5M base" could conceivably show up — let it through.
    const m = /^(\d+(?:\.\d+)?)\s*([kKmM]?)$/.exec(cleaned);
    if (!m) return null;
    let n = parseFloat(m[1]);
    if (!Number.isFinite(n)) return null;
    const suffix = m[2].toLowerCase();
    if (suffix === "k") n *= 1_000;
    else if (suffix === "m") n *= 1_000_000;
    return Math.round(n);
}

// Permissive range regex. Captures groups:
//   1: leading symbol (currency hint)
//   2: lower amount (with optional suffix)
//   3: upper amount (with optional suffix), optional
//
// Examples it matches:
//   $120k - $150k
//   $120,000 to $150,000
//   USD 120K – 150K
//   $60/hr
//   $200,000
//
// Notes:
//   - Em-dash, en-dash, "to", or hyphen as range separator.
//   - The second $ on the upper bound is optional.
//   - Lone amounts are picked up too (max becomes equal to min downstream).
const RANGE_REGEX = /(\$|USD\s*|US\$\s*)(\d{2,3}(?:,\d{3})*(?:\.\d+)?\s*[kKmM]?)(?:\s*(?:-|–|—|to|–|—)\s*\$?\s*(\d{2,3}(?:,\d{3})*(?:\.\d+)?\s*[kKmM]?))?/g;

// "Up to $200k" / "Up to $80/hr" — single-sided range, the dollar value is
// the cap. We treat min = max here (sorting buckets these alongside
// "$200k flat" rather than "$0 - $200k", which would be misleading).
const UP_TO_REGEX = /\b(?:up\s*to|max(?:imum)?\s*of|capped\s*at|as\s*high\s*as)\s*\$?\s*(\d{2,3}(?:,\d{3})*(?:\.\d+)?\s*[kKmM]?)/i;

// Plausibility guards — keep us from picking up things like "5,000 employees"
// or "$1 / hour" garbage. Bounds are deliberately loose; they widen on the
// hourly side so a real "$15/hr" doesn't get dropped.
function plausibleAnnual(n: number): boolean {
    return n >= 20_000 && n <= 5_000_000;
}
function plausibleHourly(n: number): boolean {
    return n >= 7 && n <= 1_500;
}
function isPlausible(value: number, cadence: Cadence | null): boolean {
    if (cadence === "hour") return plausibleHourly(value);
    // Day/week/month: rough sanity bounds derived from the annual bounds.
    if (cadence === "day") return value >= 50 && value <= 20_000;
    if (cadence === "week") return value >= 200 && value <= 100_000;
    if (cadence === "month") return value >= 1_000 && value <= 500_000;
    return plausibleAnnual(value);
}

export function parseCompensation(text: string | null | undefined): ParsedCompensation | null {
    if (!text) return null;
    const cadence = detectCadence(text);

    // First pass: anchored ranges with a leading symbol/currency.
    // We need the global flag to iterate, so reset lastIndex per call.
    RANGE_REGEX.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = RANGE_REGEX.exec(text)) !== null) {
        const lowRaw = m[2];
        const highRaw = m[3];
        const lo = parseAmount(lowRaw);
        if (lo === null) continue;
        if (highRaw) {
            const hi = parseAmount(highRaw);
            if (hi === null) continue;
            // Range expansion: if the high amount has no k/m suffix but the low one did,
            // assume the same magnitude (e.g. "$120k-150" → both 120000/150000).
            const loHasSuffix = /[kKmM]\s*$/.test(lowRaw.trim());
            const hiHasSuffix = /[kKmM]\s*$/.test(highRaw.trim());
            let normHi = hi;
            if (loHasSuffix && !hiHasSuffix && hi < lo) {
                // Magnitude mismatch — try multiplying by 1k (so "120k-150" reads as 150k).
                normHi = hi * 1_000;
            }
            const lower = Math.min(lo, normHi);
            const upper = Math.max(lo, normHi);
            if (isPlausible(lower, cadence) && isPlausible(upper, cadence)) {
                return { min: lower, max: upper, currency: "USD", cadence };
            }
            continue; // try the next match
        }
        // Single-sided. Only take it if no "up to" pattern is the one being
        // referenced (handled below), and it's plausible.
        if (isPlausible(lo, cadence)) {
            return { min: lo, max: lo, currency: "USD", cadence };
        }
    }

    // Second pass: "up to $X" / "capped at $X".
    const upTo = UP_TO_REGEX.exec(text);
    if (upTo) {
        const cap = parseAmount(upTo[1]);
        if (cap !== null && isPlausible(cap, cadence)) {
            return { min: cap, max: cap, currency: "USD", cadence };
        }
    }

    return null;
}
