/**
 * Profile-link URL validator + normalizer.
 *
 * The LLM extraction path (lib/profile/import-llm.ts, lib/profile/synthesize.ts)
 * declares `url: z.string()` rather than `z.string().url()`, because their
 * upstream prompts surface URLs that may be scheme-less (e.g. "github.com/u").
 * That laxness occasionally lets the model emit section-header text as the URL
 * value ("Github", "LinkedIn") — which then renders as a useless link in the
 * resume header alongside the real one. Filtering here at the merge/render
 * boundary is the chokepoint that catches both extraction paths.
 *
 * Accepting scheme-less input is deliberate (that IS how a resume writes a
 * link) but storing it raw is not: a scheme-less value fails the wire contract
 * (`ProfileLinkSchema.url` is `z.string().url()`, which requires a scheme —
 * every GET /api/profile then trips the dev shape check in lib/api-client.ts)
 * AND renders as a *relative* `href` in the generated resume, pointing the
 * reader back at this app instead of at GitHub. So the accept/reject decision
 * and the canonical form it produces are one function: `normalizeUrl` returns
 * the scheme-bearing URL or null, and `isValidUrl` is defined in terms of it
 * so the two notions of "is this a URL" can never drift apart.
 */
export function normalizeUrl(s: string | null | undefined): string | null {
    if (!s) return null;
    const v = s.trim();
    if (!v || /\s/.test(v)) return null;
    // Has a scheme (http://, https://, mailto:, etc.) — defer to URL.canParse
    // and keep the value verbatim. URL.canParse("https://Github") returns true
    // (single-label intranet host), but that only happens if someone
    // deliberately typed a scheme, so it's not the LLM-hallucination pattern
    // we're guarding against.
    if (/^[a-z][a-z0-9+.-]*:/i.test(v)) return URL.canParse(v) ? v : null;
    // Scheme-less: require a dot followed by a TLD-like segment, no spaces or
    // brackets. Rejects "Github" and "LinkedIn"; accepts "github.com/u" — and
    // promotes it to "https://github.com/u", the only form that both satisfies
    // z.string().url() and resolves as an absolute href.
    if (!/\.[a-z]{2,}/i.test(v) || /[<>"\\]/.test(v)) return null;
    const withScheme = `https://${v}`;
    return URL.canParse(withScheme) ? withScheme : null;
}

export function isValidUrl(s: string | null | undefined): boolean {
    return normalizeUrl(s) !== null;
}
