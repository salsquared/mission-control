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
            // PB-ext-5: ~1,177 jobs at last count. 60 × 20 = 1,200 posting cap.
            maxPages: 60,
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
            // PB-ext-5: ~957 jobs at last count.
            maxPages: 50,
        },
    },
    {
        name: "Axiom Space",
        blurb: "Commercial space stations + private astronaut missions.",
        tags: ["space"],
        // Verified 2026-05-19: careers page embeds the Workday tenant
        // axiomspace.wd5.myworkdayjobs.com/External_Career_Site.
        config: {
            kind: "workday",
            tenantHost: "axiomspace.wd5.myworkdayjobs.com",
            careerSite: "External_Career_Site",
            companyName: "Axiom Space",
        },
    },
    {
        name: "LeoLabs",
        blurb: "Low-Earth-orbit radar tracking + space domain awareness.",
        tags: ["space"],
        // Verified 2026-05-19: careers page embeds Greenhouse with for=leolabsinc;
        // boards-api.greenhouse.io/v1/boards/leolabsinc/jobs returns 200.
        config: { kind: "greenhouse", boardSlug: "leolabsinc", companyName: "LeoLabs" },
    },
    {
        name: "Relativity Space",
        blurb: "3D-printed rockets — Terran R reusable medium-lift launch vehicle.",
        tags: ["space"],
        // Verified 2026-05-19: their marketing /careers page is a Squarespace
        // SPA with no ATS marker, but /jobs embeds Greenhouse with
        // for=relativity. boards-api returns 287 jobs at this slug.
        config: { kind: "greenhouse", boardSlug: "relativity", companyName: "Relativity Space" },
    },
    {
        name: "Stoke Space",
        blurb: "Fully reusable second stage — Nova rocket development.",
        tags: ["space"],
        // Verified 2026-05-19: /careers landing page is decorative; the real
        // openings live at /careers/current-openings/, which embeds
        // Greenhouse with for=stokespacetechnologies. 46 jobs at the slug.
        config: { kind: "greenhouse", boardSlug: "stokespacetechnologies", companyName: "Stoke Space" },
    },
    {
        name: "Firefly Aerospace",
        blurb: "Alpha small launch vehicle, Blue Ghost lunar lander.",
        tags: ["space"],
        // Verified 2026-05-19: WordPress-fronted careers page embeds
        // ClearCompany via <script src="…/career-site.js?siteId=…">.
        // careers-api.clearcompany.com/v1/<siteId> returns 135 jobs.
        config: {
            kind: "clearcompany",
            boardSlug: "00ed92c3-5bfb-7bfb-456d-4d9d77fef9a5",
            companyName: "Firefly Aerospace",
        },
    },
    // ─── Space discoveries from the ats-sniff probe sweep, 2026-05-19 ────────
    {
        name: "True Anomaly",
        blurb: "Space security + autonomous orbital vehicles.",
        tags: ["space"],
        config: { kind: "greenhouse", boardSlug: "trueanomalyinc", companyName: "True Anomaly" },
    },
    {
        name: "Apex Space",
        blurb: "Standardized satellite bus manufacturing.",
        tags: ["space"],
        // Ashby slug is "apex-technology-inc" (the corporate name); display
        // remains "Apex Space" to match how candidates refer to them.
        config: { kind: "ashby", boardSlug: "apex-technology-inc", companyName: "Apex Space" },
    },
    {
        name: "Saronic",
        blurb: "Autonomous surface vessels + maritime defense.",
        tags: ["space"],
        config: { kind: "ashby", boardSlug: "saronic", companyName: "Saronic" },
    },
    {
        name: "Slingshot Aerospace",
        blurb: "Space domain awareness + sat-tracking simulations.",
        tags: ["space"],
        config: { kind: "greenhouse", boardSlug: "slingshotaerospace", companyName: "Slingshot Aerospace" },
    },
    {
        name: "Hadrian",
        blurb: "Robotic precision-component factories for aerospace + defense.",
        tags: ["space"],
        config: { kind: "ashby", boardSlug: "hadrian-automation", companyName: "Hadrian" },
    },
    {
        name: "Hermeus",
        blurb: "Hypersonic aircraft — Quarterhorse + Darkhorse.",
        tags: ["space"],
        config: { kind: "lever", boardSlug: "hermeus", companyName: "Hermeus" },
    },
    {
        name: "Loft Orbital",
        blurb: "Turnkey satellite missions for hosted payloads.",
        tags: ["space"],
        config: { kind: "lever", boardSlug: "loftorbital", companyName: "Loft Orbital" },
    },
    {
        name: "ispace",
        blurb: "Lunar landers + exploration — HAKUTO-R missions.",
        tags: ["space"],
        config: { kind: "lever", boardSlug: "ispace-inc", companyName: "ispace" },
    },
    {
        name: "Maxar",
        blurb: "Earth-imaging satellites + space infrastructure (rebranding to Vantor).",
        tags: ["space"],
        // Verified 2026-05-19: maxar.wd1.myworkdayjobs.com/Vantor.
        config: {
            kind: "workday",
            tenantHost: "maxar.wd1.myworkdayjobs.com",
            careerSite: "Vantor",
            companyName: "Maxar",
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
        case "workable":
        case "recruitee":
        case "personio":
            return `${config.kind}:${config.boardSlug.toLowerCase()}`;
        case "smartrecruiters":
            // Case-sensitive slug on SmartRecruiters' side; keep case to avoid
            // collapsing distinct boards (Visa vs visa1, etc.).
            return `smartrecruiters:${config.boardSlug}`;
        case "clearcompany":
            // siteId is a UUID — case-fold for consistency since UUIDs are
            // canonically lowercase but some sources mix case.
            return `clearcompany:${config.boardSlug.toLowerCase()}`;
        case "workday":
            return `workday:${config.tenantHost.toLowerCase()}:${config.careerSite}`;
        case "linkedin":
        case "careers-page":
            return null;
    }
}
