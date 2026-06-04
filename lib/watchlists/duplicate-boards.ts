import { watchlistConfigKey } from "@/lib/company-directory";
import type { WatchlistConfig } from "@/lib/schemas/watchlists";

export interface DuplicateBoardGroup {
    /** The shared watchlistConfigKey (kind + slug/tenant) the group collides on. */
    key: string;
    /** Distinct display names (companyName) seen for this board, sorted. */
    names: string[];
    /** How many watchlists target this one board. */
    count: number;
}

/**
 * Detect watchlists that target the SAME job board — the structural cause of
 * the "Apex / Apex Space" duplicate-company badges (one greenhouse board added
 * twice under two display names). Two configs collide when they share a
 * watchlistConfigKey (kind + slug/tenant).
 *
 * This is DETECTION ONLY. The watchlist POST route blocks creating a colliding
 * board (409), but a pre-existing dup, a hand-edited row, or a directory
 * hydration flip could still produce one — so NewPostingsCard surfaces any
 * group here as a visible ⚠ banner. Nothing merges or hides the badges: the
 * point is that a dedup failure stays *visible* (the user explicitly declined
 * auto-grouping for exactly this reason).
 *
 * Keyword aggregators (linkedin / indeed) and careers-page return a null key
 * and are never grouped — their overlap is intentional. Returns one group per
 * colliding board (count ≥ 2), empty when every board is unique.
 */
export function findDuplicateBoardGroups(
    configs: readonly WatchlistConfig[],
): DuplicateBoardGroup[] {
    const groups = new Map<string, { names: Set<string>; count: number }>();
    for (const config of configs) {
        const key = watchlistConfigKey(config);
        if (!key) continue; // board-less kinds (linkedin/indeed/careers-page) overlap freely
        const g = groups.get(key) ?? { names: new Set<string>(), count: 0 };
        g.count++;
        const name = (config.companyName ?? "").trim();
        if (name) g.names.add(name);
        groups.set(key, g);
    }
    const out: DuplicateBoardGroup[] = [];
    for (const [key, g] of groups) {
        if (g.count >= 2) {
            out.push({ key, names: [...g.names].sort((a, b) => a.localeCompare(b)), count: g.count });
        }
    }
    return out;
}
