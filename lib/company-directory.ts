/**
 * Curated directory of companies the "Watch company" picker in
 * components/overlays/AddWatchlistModal.tsx pulls from.
 *
 * Each entry maps a human-recognizable name to a ready-to-submit Watchlist
 * config — so the user doesn't have to know what an ATS is, let alone which
 * Greenhouse slug a company uses or what their Workday tenant host is.
 *
 * Start small (the six we've verified or expect to work — see
 * docs/implementation.md §MB Phase 2). Add entries by hand here as new
 * companies become interesting; if this list grows past ~30, consider a
 * crawler that auto-discovers ATS + slug from a careers-page URL.
 *
 * Slug verification — Workday entries are verified live (Boeing 1,177 jobs,
 * Blue Origin 957 jobs); Greenhouse slugs are educated guesses based on the
 * canonical boards.greenhouse.io/<slug> pattern these companies publish. If
 * a "Run now" returns 0 postings on a fresh watchlist, the slug is the most
 * likely culprit — adjust here.
 */
import type { WatchlistConfig } from "@/lib/schemas/watchlists";

export type DirectoryTag = "ai" | "space" | "tech" | "biotech" | "finance";

export interface CompanyDirectoryEntry {
    /** Display name shown in the picker. Must be unique. */
    name: string;
    /** Short blurb under the name (e.g. "AI research lab"). */
    blurb?: string;
    /** Tags drive filter chips at the top of the picker. */
    tags: DirectoryTag[];
    /**
     * Fully-formed Watchlist config — exactly what the API expects for POST
     * /api/watchlists. The `companyName` inside this config is what postings
     * get attributed to in the bell / NewPostingsCard.
     */
    config: WatchlistConfig;
}

export const COMPANY_DIRECTORY: readonly CompanyDirectoryEntry[] = [
    // ─── AI / ML ─────────────────────────────────────────────────────────────
    {
        name: "Anthropic",
        blurb: "AI safety research lab (Claude).",
        tags: ["ai"],
        config: { kind: "greenhouse", boardSlug: "anthropic", companyName: "Anthropic" },
    },
    {
        name: "OpenAI",
        blurb: "Frontier AI lab (ChatGPT).",
        tags: ["ai"],
        config: { kind: "ashby", boardSlug: "openai", companyName: "OpenAI" },
    },
    {
        name: "Perplexity",
        blurb: "AI answer engine.",
        tags: ["ai"],
        config: { kind: "ashby", boardSlug: "perplexity", companyName: "Perplexity" },
    },
    {
        name: "Scale AI",
        blurb: "ML data labeling + RLHF.",
        tags: ["ai"],
        config: { kind: "greenhouse", boardSlug: "scaleai", companyName: "Scale AI" },
    },
    {
        name: "LangChain",
        blurb: "LLM app framework + LangSmith.",
        tags: ["ai"],
        config: { kind: "ashby", boardSlug: "langchain", companyName: "LangChain" },
    },
    {
        name: "Notion",
        blurb: "Docs + database + AI.",
        tags: ["ai", "tech"],
        config: { kind: "ashby", boardSlug: "notion", companyName: "Notion" },
    },
    {
        name: "PostHog",
        blurb: "Open-source product analytics.",
        tags: ["ai", "tech"],
        config: { kind: "ashby", boardSlug: "posthog", companyName: "PostHog" },
    },

    // ─── Space / Aerospace ───────────────────────────────────────────────────
    {
        name: "Rocket Lab",
        blurb: "Small-launch + spacecraft.",
        tags: ["space"],
        // Verified live 2026-05-17: HTTP 200 with 840 jobs at this slug.
        // The careers website lives at rocketlabusa.com but the Greenhouse
        // board slug is just `rocketlab`.
        config: { kind: "greenhouse", boardSlug: "rocketlab", companyName: "Rocket Lab" },
    },
    {
        name: "Astranis",
        blurb: "Small geostationary comms sats.",
        tags: ["space"],
        config: { kind: "greenhouse", boardSlug: "astranis", companyName: "Astranis" },
    },
    {
        name: "Planet",
        blurb: "Earth-imaging satellites.",
        tags: ["space"],
        // Public name "Planet" but board slug retains the legacy "planetlabs" name.
        config: { kind: "greenhouse", boardSlug: "planetlabs", companyName: "Planet" },
    },
    {
        name: "Boeing",
        blurb: "Aerospace & defense.",
        tags: ["space"],
        config: {
            kind: "workday",
            tenantHost: "boeing.wd1.myworkdayjobs.com",
            careerSite: "EXTERNAL_CAREERS",
            companyName: "Boeing",
        },
    },
    {
        name: "Blue Origin",
        blurb: "Rocket engines + New Glenn.",
        tags: ["space"],
        config: {
            kind: "workday",
            tenantHost: "blueorigin.wd5.myworkdayjobs.com",
            careerSite: "BlueOrigin",
            companyName: "Blue Origin",
        },
    },

    // ─── Tech / SaaS ─────────────────────────────────────────────────────────
    {
        name: "Stripe",
        blurb: "Payments infrastructure.",
        tags: ["tech", "finance"],
        config: { kind: "greenhouse", boardSlug: "stripe", companyName: "Stripe" },
    },
    {
        name: "Vercel",
        blurb: "Frontend cloud (Next.js).",
        tags: ["tech"],
        config: { kind: "greenhouse", boardSlug: "vercel", companyName: "Vercel" },
    },
    {
        name: "Datadog",
        blurb: "Observability + monitoring.",
        tags: ["tech"],
        config: { kind: "greenhouse", boardSlug: "datadog", companyName: "Datadog" },
    },
    {
        name: "Cloudflare",
        blurb: "Edge network + Workers.",
        tags: ["tech"],
        config: { kind: "greenhouse", boardSlug: "cloudflare", companyName: "Cloudflare" },
    },
    {
        name: "GitLab",
        blurb: "DevOps platform.",
        tags: ["tech"],
        config: { kind: "greenhouse", boardSlug: "gitlab", companyName: "GitLab" },
    },
    {
        name: "Dropbox",
        blurb: "File sync + collaboration.",
        tags: ["tech"],
        config: { kind: "greenhouse", boardSlug: "dropbox", companyName: "Dropbox" },
    },
    {
        name: "Discord",
        blurb: "Real-time chat platform.",
        tags: ["tech"],
        config: { kind: "greenhouse", boardSlug: "discord", companyName: "Discord" },
    },
    {
        name: "Reddit",
        blurb: "Social link aggregator.",
        tags: ["tech"],
        config: { kind: "greenhouse", boardSlug: "reddit", companyName: "Reddit" },
    },
    {
        name: "Figma",
        blurb: "Collaborative design tool.",
        tags: ["tech"],
        config: { kind: "greenhouse", boardSlug: "figma", companyName: "Figma" },
    },
    {
        name: "Asana",
        blurb: "Work management.",
        tags: ["tech"],
        config: { kind: "greenhouse", boardSlug: "asana", companyName: "Asana" },
    },
    {
        name: "Webflow",
        blurb: "Visual web builder.",
        tags: ["tech"],
        config: { kind: "greenhouse", boardSlug: "webflow", companyName: "Webflow" },
    },
    {
        name: "Linear",
        blurb: "Issue tracking for engineers.",
        tags: ["tech"],
        config: { kind: "ashby", boardSlug: "linear", companyName: "Linear" },
    },
    {
        name: "Spotify",
        blurb: "Music streaming.",
        tags: ["tech"],
        config: { kind: "lever", boardSlug: "spotify", companyName: "Spotify" },
    },

    // ─── Finance / Crypto ────────────────────────────────────────────────────
    {
        name: "Brex",
        blurb: "Corporate cards + spend mgmt.",
        tags: ["finance"],
        config: { kind: "greenhouse", boardSlug: "brex", companyName: "Brex" },
    },
    {
        name: "Robinhood",
        blurb: "Retail brokerage.",
        tags: ["finance"],
        config: { kind: "greenhouse", boardSlug: "robinhood", companyName: "Robinhood" },
    },
    {
        name: "Ramp",
        blurb: "Corporate cards + automation.",
        tags: ["finance"],
        config: { kind: "ashby", boardSlug: "ramp", companyName: "Ramp" },
    },
    {
        name: "Mercury",
        blurb: "Banking for startups.",
        tags: ["tech", "finance"],
        config: { kind: "ashby", boardSlug: "mercury", companyName: "Mercury" },
    },

    // ─── Biotech ─────────────────────────────────────────────────────────────
    {
        name: "Recursion",
        blurb: "AI-driven drug discovery.",
        tags: ["biotech"],
        config: { kind: "greenhouse", boardSlug: "recursionpharmaceuticals", companyName: "Recursion" },
    },
] as const;

export const DIRECTORY_TAGS: readonly DirectoryTag[] = ["ai", "space", "tech", "biotech", "finance"] as const;

/** Filter the directory by free-text query (matches name) + tag intersection. */
export function searchDirectory(
    query: string,
    tags: ReadonlySet<DirectoryTag> | null,
): CompanyDirectoryEntry[] {
    const q = query.trim().toLowerCase();
    return COMPANY_DIRECTORY.filter(entry => {
        if (q && !entry.name.toLowerCase().includes(q) && !(entry.blurb ?? "").toLowerCase().includes(q)) {
            return false;
        }
        if (tags && tags.size > 0 && !entry.tags.some(t => tags.has(t))) {
            return false;
        }
        return true;
    });
}

/**
 * Identity key for a WatchlistConfig — used by the "Watch company" picker to
 * detect when a directory entry is already on the user's watchlist. Two configs
 * with the same key target the same job board.
 *
 * Returns `null` for kinds we don't dedup (`linkedin` keyword searches and
 * `careers-page` configs aren't in the directory and shouldn't be compared).
 */
export function watchlistConfigKey(config: WatchlistConfig): string | null {
    switch (config.kind) {
        case "greenhouse":
        case "lever":
        case "ashby":
            return `${config.kind}:${config.boardSlug.toLowerCase()}`;
        case "workday":
            return `workday:${config.tenantHost.toLowerCase()}:${config.careerSite}`;
        case "linkedin":
        case "careers-page":
            return null;
    }
}
