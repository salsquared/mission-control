import type { NewsArticle } from '../fetchers/types';

// CompanyAdapter is the unit of plug-in for the company-news pipeline. Each
// company in lib/companies/<id>.ts exports a default CompanyAdapter built via
// one of the factories in ./factories. Adding a new company is one new file —
// the index assembles them via explicit imports (compile-time discovery).
//
// The contract is deliberately narrow: identity, classification, and a fetch.
// Per the MVP2 risk callout: "Plugin architectures over-engineer easily;
// resist the urge to make the contract too rich. Stick to fetch + health and
// let composition do the rest."
export interface CompanyAdapter {
    /** Unique identifier used as the `?company=<id>` query param. */
    id: string;
    /** Display name. */
    name: string;
    /** Which dashboard view this company shows up on. */
    view: 'space' | 'ai' | 'both';
    /** Subcategory used to group cards in the UI ('Prime Contractors', 'Fabless', etc.). */
    category: string;
    /** Cache-TTL hint in seconds. Informational today — withCache uses a single
     *  per-route TTL — but kept on the adapter so a future per-key cache
     *  layer can pick it up. */
    ttlSeconds?: number;
    /** Upstream hostname tagged on cache log lines so the InternalView fetcher
     *  health tile can group by real upstream. Empty when the adapter hits
     *  multiple hosts (typically custom fetchers). */
    upstreamHost?: string;
    /** Fetch the latest articles. The factory wires this to the appropriate
     *  strategy (rss/scrape/snapi/google-news) or to a hand-written fetcher. */
    fetch: () => Promise<NewsArticle[]>;
}
