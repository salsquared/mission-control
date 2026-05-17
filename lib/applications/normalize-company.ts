/**
 * PB-1: normalize LLM-classified company names so the same employer doesn't
 * yield duplicate Application rows when the classifier drifts on suffix
 * wording.
 *
 * Observed (Bell Smoke Co diagnostic, 2026-05-17): one email's classification
 * was `"Bell Smoke"`, another from the same sender 11 minutes later was
 * `"Bell Smoke Co"`. PB-7's case-insensitive exact match in
 * findApplicationByCompany doesn't bridge that — two rows get created.
 *
 * Pipeline (applied in order):
 *   1. NFKC Unicode normalize — collapses compatibility forms ("ﬁ" → "fi"),
 *      decomposed accents, full-width Latin, etc. Defensive against any
 *      Unicode quirk in classifier output.
 *   2. Trim + collapse internal whitespace.
 *   3. Strip leading "The " (case-insensitive).
 *   4. Iteratively strip trailing legal-suffix tokens + punctuation, so
 *      "Acme, Inc." → "Acme", "Boring Co., Ltd." → "Boring".
 *
 * Output is what we pass to findApplicationByCompany AND what we persist as
 * Application.company. (Both halves of the comparison get the same treatment.)
 *
 * Idempotent: normalize(normalize(x)) === normalize(x).
 *
 * Returns empty string only if the input was empty/whitespace-only.
 */

// Bare suffix tokens we strip from the end. Match case-insensitively. The
// order doesn't matter — we loop until no more strip — but keep the longer
// "Corporation" / "Limited" forms in the list alongside the abbreviations
// or the loop won't catch "X Limited" (we'd only strip "Ltd").
const LEGAL_SUFFIXES = [
    "incorporated", "inc",
    "corporation", "corp",
    "limited liability company", "llc",
    "limited liability partnership", "llp",
    "limited", "ltd",
    "company", "co",
    "gmbh", "ag", "kg",
    "sa", "sas", "sl",
    "nv", "bv",
    "plc", "pty",
    "kk", "kabushiki kaisha",
    "holdings", "group",
    // Common public-benefit / partnership tags that show up on US filings.
    "pbc", "lp", "lllp",
];

// Build a single anchored alternation, sorted longest-first so multi-word
// variants ("Limited Liability Company") win over their abbreviations.
const SORTED_SUFFIXES = [...LEGAL_SUFFIXES].sort((a, b) => b.length - a.length);
const SUFFIX_PATTERN = new RegExp(
    `[\\s,.\\-]+(?:${SORTED_SUFFIXES.map(s => s.replace(/\s+/g, "\\s+")).join("|")})\\.?$`,
    "i",
);

// Leading "The " — only when followed by another word (so "The" alone stays).
const LEADING_THE = /^\s*the\s+(?=\S)/i;

// Trailing residual punctuation after suffix strip ("Acme," → "Acme").
const TRAILING_PUNCT = /[\s,.\-]+$/;

export function normalizeCompanyName(raw: string): string {
    if (!raw) return "";

    // 1. Unicode NFKC + whitespace collapse.
    let s = raw.normalize("NFKC").replace(/\s+/g, " ").trim();
    if (!s) return "";

    // 2. Strip leading "The " if it precedes another word.
    s = s.replace(LEADING_THE, "");

    // 3. Iteratively strip trailing legal suffixes. The pattern eats one
    //    suffix at a time so "Acme Co., Ltd." → "Acme Co." → "Acme".
    let prev: string;
    do {
        prev = s;
        s = s.replace(SUFFIX_PATTERN, "");
        s = s.replace(TRAILING_PUNCT, "");
    } while (s !== prev && s.length > 0);

    return s.trim();
}
