/**
 * Profile-link URL validator.
 *
 * The LLM extraction path (lib/profile/import-llm.ts, lib/profile/synthesize.ts)
 * declares `url: z.string()` rather than `z.string().url()`, because their
 * upstream prompts surface URLs that may be scheme-less (e.g. "github.com/u").
 * That laxness occasionally lets the model emit section-header text as the URL
 * value ("Github", "LinkedIn") — which then renders as a useless link in the
 * resume header alongside the real one. Filtering here at the merge/render
 * boundary is the chokepoint that catches both extraction paths.
 */
export function isValidUrl(s: string | null | undefined): boolean {
    if (!s) return false;
    const v = s.trim();
    if (!v || /\s/.test(v)) return false;
    // Has a scheme (http://, https://, mailto:, etc.) — defer to URL.canParse.
    // URL.canParse("https://Github") returns true (single-label intranet host),
    // but that only happens if someone deliberately typed a scheme, so it's not
    // the LLM-hallucination pattern we're guarding against.
    if (/^[a-z][a-z0-9+.-]*:/i.test(v)) return URL.canParse(v);
    // Scheme-less: require a dot followed by a TLD-like segment, no spaces or
    // brackets. Rejects "Github" and "LinkedIn"; accepts "github.com/u".
    return /\.[a-z]{2,}/i.test(v) && !/[<>"\\]/.test(v);
}
