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
    {
        name: "Anthropic",
        blurb: "AI safety research lab (Claude).",
        tags: ["ai"],
        config: { kind: "greenhouse", boardSlug: "anthropic", companyName: "Anthropic" },
    },
    {
        name: "Stripe",
        blurb: "Payments infrastructure.",
        tags: ["tech", "finance"],
        config: { kind: "greenhouse", boardSlug: "stripe", companyName: "Stripe" },
    },
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
        name: "Vercel",
        blurb: "Frontend cloud (Next.js).",
        tags: ["tech"],
        config: { kind: "greenhouse", boardSlug: "vercel", companyName: "Vercel" },
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
