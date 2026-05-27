/**
 * Role normalizer (2026-05-27): distinguishes multiple applications at the
 * same company by role. Replaces the previous `@@unique([userId,
 * normalizedCompany, track])` invariant — a user can now have two Allied
 * Universal roles on the side kanban as long as their normalized titles differ.
 *
 * Rule B (operator-chosen): keep parens content as additional tokens. Strips
 * employment-modality tokens that don't change role identity (part time, full
 * time, remote, hybrid, contract, intern), but keeps substantive modifiers
 * (senior, junior, lead, principal, staff).
 *
 *   "Security Officer Part Time Museum Rover" → "security officer museum rover"
 *   "Part-Time Security Officer (Museum)"     → "security officer museum"
 *   "Senior Software Engineer (Remote)"       → "senior software engineer"
 *   "Software Engineer, Backend"              → "software engineer backend"
 *
 * Output is what gets persisted on Application.normalizedRole and what
 * findApplicationByCompanyAndRole compares against. Both sides of the
 * comparison run through the same function.
 *
 * Idempotent: normalize(normalize(x)) === normalize(x).
 * Returns "" only when input is empty/whitespace-only/entirely noise.
 */

// Employment-modality words that don't change role identity. Matched as whole
// tokens (case-insensitive) after punctuation is stripped. "part time" is
// handled as two adjacent tokens — the tokenizer makes that work naturally.
const NOISE_TOKENS = new Set([
    "part", "time", "full",
    "pt", "ft",
    "remote", "hybrid", "onsite", "onpremise",
    "contract", "contractor", "freelance",
    "temporary", "temp",
    "intern", "internship",
    "permanent",
    // Light articles that creep in via title strings.
    "the", "a", "an",
]);

// Punctuation that becomes a token separator. Note: parens are INCLUDED here
// (Rule B) — the chars (, ) become whitespace and the words inside become
// tokens like any other. ⟨ slash and ampersand and pipe also split.
const PUNCT = /[.,()/\\\-–—:;|&]+/g;

export function normalizeRoleName(raw: string): string {
    if (!raw) return "";

    // 1. Unicode NFKC + lowercase.
    let s = raw.normalize("NFKC").toLowerCase();

    // 2. Replace punctuation with spaces (including parens — Rule B).
    s = s.replace(PUNCT, " ");

    // 3. Tokenize on whitespace, drop noise tokens, collapse.
    const tokens = s
        .split(/\s+/)
        .map(t => t.trim())
        .filter(t => t.length > 0)
        .filter(t => !NOISE_TOKENS.has(t));

    return tokens.join(" ");
}
