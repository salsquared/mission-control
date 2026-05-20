// Keyword + sender-domain set used to identify likely application emails.
//
// The same set is consumed in two places:
//   - buildGmailQuery(days)  → Gmail search query used by the backfill route.
//   - looksRelevant(...)     → per-message pre-filter used by the live
//                              webhook to avoid sending every new email to
//                              the LLM classifier.
//
// Be generous: the LLM classifier (lib/email-parser.ts) is the final relevance
// gate. False positives here just cost a few Gemini tokens; false negatives
// silently drop application emails on the floor, which is much worse.

const PHRASES: readonly string[] = [
    // Job / internship application acks
    "thank you for applying",
    "thanks for applying",
    "thank you for your application",
    "your application",
    "application received",
    "application status",
    "application update",
    "we received your application",
    // Stage transitions
    "next steps",
    "interview",
    "phone screen",
    "technical screen",
    "take-home",
    "take home",
    "assessment",
    "coding challenge",
    "online assessment",
    // Outcomes
    "offer letter",
    "offer of employment",
    "we're excited to offer",
    "unfortunately",
    "we have decided",
    "not moving forward",
    // Internships
    "internship",
    "co-op",
    "summer 2026",
    "summer intern",
    // College / university admissions
    "admission decision",
    "admissions decision",
    "decision is now available",
    "your decision",
    "you have been admitted",
    "admitted to",
    "offer of admission",
    "waitlist",
    "wait list",
    "deferred",
    "supplemental materials",
    "transcript",
];

// Multi-tenant ATS / admissions platforms. Two callers:
//   - relevance pre-filter: a `from:` clause on any of these is a positive signal.
//   - sender-domain dedup (lib/applications/sender-domain.ts): an extracted
//     registrable-root match against this list is BLOCKED — multiple distinct
//     employers/schools share each of these roots, so the sender domain is
//     not a reliable identity signal for them.
// Exported so both callers stay in sync.
export const SENDER_DOMAINS: readonly string[] = [
    // ATS platforms
    "greenhouse.io",
    "lever.co",
    "hire.lever.co",
    "myworkday.com",
    "myworkdayjobs.com",
    "smartrecruiters.com",
    "jobvite.com",
    "icims.com",
    "ashbyhq.com",
    "workable.com",
    "breezy.hr",
    "rippling-ats.com",
    "bamboohr.com",
    "successfactors.com",
    "taleo.net",
    // College / admissions platforms
    "commonapp.org",
    "applyweb.com",
    "applyyourself.com",
    "slate.org",
    "technolutions.net",
];

/**
 * Build a Gmail search query that filters to application-likely messages
 * within the last N days. Used by the backfill route.
 *
 * Gmail's `q` parameter accepts the same syntax as the search bar. We OR
 * together quoted phrases and `from:` clauses; Gmail interprets unquoted
 * spaces as AND, so each phrase MUST be quoted.
 */
export function buildGmailQuery(days: number): string {
    const phraseClauses = PHRASES.map((p) => `"${p}"`);
    const senderClauses = SENDER_DOMAINS.map((d) => `from:${d}`);
    const orBlock = [...phraseClauses, ...senderClauses].join(" OR ");
    // Exclude obvious noise. `category:promotions` catches most marketing.
    return `newer_than:${days}d (${orBlock}) -category:promotions`;
}

/**
 * Per-message pre-filter for the live Gmail webhook. Returns true if the
 * subject, sender, or snippet contains any of our application-related
 * keywords or sender domains.
 */
export function looksRelevant(args: {
    subject?: string | null;
    from?: string | null;
    snippet?: string | null;
}): boolean {
    const subject = (args.subject ?? "").toLowerCase();
    const from = (args.from ?? "").toLowerCase();
    const snippet = (args.snippet ?? "").toLowerCase();

    for (const domain of SENDER_DOMAINS) {
        if (from.includes(domain)) return true;
    }

    const haystack = `${subject} ${snippet}`;
    for (const phrase of PHRASES) {
        if (haystack.includes(phrase)) return true;
    }

    return false;
}
