/**
 * Sender-domain extraction for the layered application-dedup fallback.
 *
 * Background: `Application.normalizedCompany` is the primary dedup key (PA-3 /
 * PB-1), but it relies on the LLM classifier producing the same canonical
 * company string for every email from the same employer. The classifier
 * drifts — observed on Cal State Long Beach (2026-05-20), where three
 * admissions emails from the same `*.csulb.edu` sender were classified as
 * "California State University, Long Beach" / "Cal State Long Beach" / "CSULB"
 * and ended up as three rows.
 *
 * The sender's email domain is a much more stable identity signal: every
 * email from one employer/institution almost always comes from the same
 * registrable root. We use it as a fallback: try `findApplicationByCompany`
 * first, fall through to `findApplicationBySenderDomain` only on miss.
 *
 * IMPORTANT: multi-tenant ATS / admissions platforms (Greenhouse, Lever,
 * Workday, Common App, …) AND consumer free-mail providers (gmail.com,
 * outlook.com, …) share one root across many distinct senders — dedup'ing on
 * `greenhouse.io` or `gmail.com` would merge unrelated companies. Both are
 * returned as `null` so the caller skips the fallback. Blocking free-mail also
 * stops the user's OWN notification emails (From their gmail.com) from being
 * funneled onto a single app — the 2026-06-02 self-notification loop.
 */
import { SENDER_DOMAINS, FREE_MAIL_DOMAINS } from "@/lib/applications/relevance";

// "Display Name" <user@host.tld>, or bare user@host.tld, or even
// `Name <user@host.tld>` with no quotes. The capture group grabs the address
// when angle brackets are present; the alternation falls through to the
// whole-string-as-address case.
const ANGLE_ADDRESS = /<([^>]+)>/;

// Match anything that looks like an email address (defensive — From headers
// occasionally arrive with stray quoting or trailing chars).
const EMAIL_ADDRESS = /([\w.+-]+@[\w.-]+\.[A-Za-z]{2,})/;

// Multi-tenant ATS/admissions roots AND consumer free-mail roots are both
// useless as employer-identity signals — see each list's docstring. Free-mail
// is dedup-blocked here but (deliberately) NOT a positive relevance signal.
const BLOCKED_ROOTS = new Set(
    [...SENDER_DOMAINS, ...FREE_MAIL_DOMAINS].map(d => d.toLowerCase()),
);

/**
 * Extract the registrable-root domain from a Gmail From header.
 *
 * Returns null when:
 *   - the header is missing/malformed
 *   - the extracted root is on the multi-tenant ATS / admissions blocklist
 *     (caller should NOT use it for dedup — only the LLM company name
 *     can disambiguate those)
 *
 * "Registrable root" here is a simple last-two-labels heuristic — not the
 * Public Suffix List. That's a tradeoff: we'd misidentify the registrable
 * root for ccTLDs like `.co.uk` (we'd return `co.uk`), but for dedup we
 * only care that two emails from the same employer resolve to the same
 * string, which the heuristic preserves. Both
 * `admissions@apply.csulb.edu` and `decisions@csulb.edu` resolve to
 * `csulb.edu`.
 *
 * @example
 *   extractSenderDomain('"CSULB Admissions" <admissions@apply.csulb.edu>')
 *     // → "csulb.edu"
 *   extractSenderDomain("no-reply@us.greenhouse-mail.io")
 *     // → null  (greenhouse-mail.io is NOT on the blocklist — but the
 *     //         strict greenhouse.io entry would catch any direct match.
 *     //         The example below is more representative.)
 *   extractSenderDomain("notify@boards.greenhouse.io")
 *     // → null  (greenhouse.io is blocked)
 *   extractSenderDomain("")  // → null
 */
export function extractSenderDomain(fromHeader: string | null | undefined): string | null {
    if (!fromHeader) return null;

    // Prefer angle-bracket form when present; otherwise fall through.
    const angle = fromHeader.match(ANGLE_ADDRESS);
    const candidate = angle ? angle[1] : fromHeader;

    const addrMatch = candidate.match(EMAIL_ADDRESS);
    if (!addrMatch) return null;
    const address = addrMatch[1];

    const atIdx = address.lastIndexOf("@");
    if (atIdx < 0) return null;

    const hostRaw = address.slice(atIdx + 1).toLowerCase().trim();
    if (!hostRaw) return null;

    // Strip a stray leading "www." just in case (defensive — From headers
    // almost never have it, but we'd rather normalize than skip).
    const host = hostRaw.replace(/^www\./, "");

    const labels = host.split(".").filter(Boolean);
    if (labels.length < 2) return null;

    // Last-two-labels heuristic. Good enough for `.com` / `.edu` / `.io` /
    // `.org`; the registrable root is the same string for every email from
    // the same employer regardless of subdomain.
    const root = labels.slice(-2).join(".");

    if (BLOCKED_ROOTS.has(root)) return null;
    // Defense in depth — also block if any longer entry in the blocklist
    // (e.g. "hire.lever.co") is a suffix of the host. Catches sub-domain
    // listings that the last-two-labels heuristic would otherwise miss.
    for (const blocked of BLOCKED_ROOTS) {
        if (host === blocked || host.endsWith("." + blocked)) return null;
    }

    return root;
}
