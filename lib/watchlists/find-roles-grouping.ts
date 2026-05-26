/**
 * Group "Find Roles" watchlists by their underlying search.
 *
 * The Find Roles tab in AddWatchlistModal creates one watchlist per checked
 * source (currently LinkedIn + Indeed), but those rows logically belong to a
 * single user-authored search ("Mechanical engineer — Remote"). The UI
 * collapses them back into one row so the user can edit keywords / location /
 * sources in one place — see EditFindRolesModal.
 *
 * Grouping rules:
 *   - Only kinds in `FIND_ROLES_KINDS` (linkedin, indeed) participate. Every
 *     other watchlist kind always renders as its own row.
 *   - Two watchlists collapse into the same group when their normalized
 *     `keywords + "|" + (location ?? "") + "|" + track` are equal. Normalize
 *     = trim + lowercase. This makes "Engineer  " and "engineer" collapse,
 *     and "Remote, US" stay separate from "" (no location).
 *   - Within a group, members are sorted by createdAt (oldest first) so a
 *     pre-existing LinkedIn watchlist anchors the group identity when the
 *     user later adds Indeed alongside it.
 *   - Groups are sorted by their oldest member's createdAt (descending) —
 *     so freshly-created groups float to the top. Singles are interleaved
 *     by their own createdAt.
 */
import type { WatchlistWire } from "@/lib/schemas/watchlists";

// Watchlist kinds that get the "search group" treatment. Everything else is
// per-company (slug-based) and renders as a single row.
export const FIND_ROLES_KINDS = ["linkedin", "indeed"] as const;
export type FindRolesKind = (typeof FIND_ROLES_KINDS)[number];

export function isFindRolesKind(kind: string): kind is FindRolesKind {
    return (FIND_ROLES_KINDS as readonly string[]).includes(kind);
}

export interface FindRolesGroup {
    kind: "group";
    /** Stable identity key — `${normKeywords}|${normLocation}|${track}`. */
    groupKey: string;
    /** Display values pulled from the group's anchor (oldest) member. */
    keywords: string;
    location: string | null;
    track: "career" | "side";
    /** Members sorted by createdAt ascending (anchor first). */
    members: WatchlistWire[];
}

export interface SingleRow {
    kind: "single";
    watchlist: WatchlistWire;
}

export type WatchlistRowItem = FindRolesGroup | SingleRow;

function norm(s: string | null | undefined): string {
    return (s ?? "").trim().toLowerCase();
}

/**
 * Build the group key for a watchlist. Returns `null` for kinds that don't
 * participate in grouping. The keywords/location live on the `config` field
 * for the participating kinds; reading from there keeps this purely
 * derived (no Watchlist schema changes).
 */
export function findRolesGroupKey(w: WatchlistWire): string | null {
    if (!isFindRolesKind(w.kind)) return null;
    const cfg = w.config;
    if (cfg.kind !== "linkedin" && cfg.kind !== "indeed") return null;
    return `${norm(cfg.keywords)}|${norm(cfg.location ?? null)}|${w.track}`;
}

/**
 * Partition a list of watchlists into Find Roles groups + singles. Order is
 * stable: groups + singles sorted descending by their (group-anchor or own)
 * `createdAt`, so freshly-created items float to the top.
 */
export function groupWatchlists(watchlists: readonly WatchlistWire[]): WatchlistRowItem[] {
    const groupMap = new Map<string, FindRolesGroup>();
    const singles: SingleRow[] = [];

    for (const w of watchlists) {
        const key = findRolesGroupKey(w);
        if (key === null) {
            singles.push({ kind: "single", watchlist: w });
            continue;
        }
        let g = groupMap.get(key);
        if (!g) {
            // Anchor display values from the first member we encounter; we
            // fix them up below once all members are collected.
            const cfg = w.config as { kind: "linkedin" | "indeed"; keywords: string; location?: string };
            g = {
                kind: "group",
                groupKey: key,
                keywords: cfg.keywords,
                location: cfg.location ?? null,
                track: w.track,
                members: [],
            };
            groupMap.set(key, g);
        }
        g.members.push(w);
    }

    // Within each group, sort members by createdAt ascending so the anchor
    // (oldest) member's config is the canonical display.
    for (const g of groupMap.values()) {
        g.members.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        const anchor = g.members[0].config as { kind: "linkedin" | "indeed"; keywords: string; location?: string };
        g.keywords = anchor.keywords;
        g.location = anchor.location ?? null;
    }

    // Interleave groups + singles, sorted by anchor createdAt descending.
    const items: Array<WatchlistRowItem & { _sortAt: string }> = [
        ...Array.from(groupMap.values()).map(g => ({ ...g, _sortAt: g.members[0].createdAt })),
        ...singles.map(s => ({ ...s, _sortAt: s.watchlist.createdAt })),
    ];
    items.sort((a, b) => b._sortAt.localeCompare(a._sortAt));
    return items.map(({ _sortAt: _unused, ...rest }) => {
        void _unused;
        return rest as WatchlistRowItem;
    });
}

/** Convenience: title for a group row. "Keywords — Location" / "Keywords". */
export function groupTitle(g: FindRolesGroup): string {
    return g.location ? `${g.keywords} — ${g.location}` : g.keywords;
}

/** Convenience: matches a flat name-search across either a group's title or a single's name. */
export function rowItemMatchesSearch(item: WatchlistRowItem, lowerNeedle: string): boolean {
    if (!lowerNeedle) return true;
    if (item.kind === "group") return groupTitle(item).toLowerCase().includes(lowerNeedle);
    return item.watchlist.name.toLowerCase().includes(lowerNeedle);
}
