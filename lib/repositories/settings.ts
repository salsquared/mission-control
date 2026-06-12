import { prisma } from '@/lib/prisma';
import type { GlobalSetting } from '@prisma/client';
// Pure string helper lives in a client-safe module so React Client Components
// (WatchlistsCard) can use it without dragging prisma into the browser bundle.
// Re-exported below for backward compat with server callers that still import
// it from here.
import { normalizeNegativeFilterForDedup } from '@/lib/postings/negative-filters';
import { resolveOwnerUserId } from '@/lib/user-scope';

// Negative filters are stored on a single `globalNegativeFilters` JSON
// column (legacy name kept to avoid a prisma migration). One shared list
// applies to every watchlist regardless of track — see WatchlistsCard's
// FilterButton. Parser below unions both legacy shapes (raw array and
// per-track `{career,side}` map) into one flat list on read.

export { normalizeNegativeFilterForDedup };

export interface GlobalSettingData {
    isDarkMode: boolean;
    viewHuesEnabled: boolean;
    viewHues: Record<string, number>;
    dashOrder: string[];
    dashTitles: Record<string, string>;
    negativeFilters: string[];
    // Watchlist IDs the user hid from the New/Side postings feed (eye toggle in
    // WatchlistsCard). Synced cross-device so every device shows the same feed.
    hiddenWatchlistIds: string[];
    version: number;
}

// Parse a JSON string[] column, dropping non-strings. Returns [] on any
// malformed input so a corrupt column never throws the whole settings read.
function parseStringArray(raw: string | null | undefined): string[] {
    if (!raw) return [];
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return []; }
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : [];
}

export type UpsertResult =
    | { ok: true; newVersion: number }
    | { ok: false; currentVersion: number };

// P2.3 (OQ2a): GlobalSetting is one row PER USER, keyed on the unique userId.
// The pre-scoping singleton kept its legacy id 'global' and was backfilled to
// the owner account, so owner reads land on the same row as before.
export function findGlobalSettingForUser(userId: string): Promise<GlobalSetting | null> {
    return prisma.globalSetting.findUnique({ where: { userId } });
}

// Session-less owner read for non-request contexts: the scheduler jobs
// (job-watcher / posting-digest / classify-pending sweeps) and the postings
// feed read ONE settings row for negative filters + hidden watchlists, and
// have no session to scope by. Resolves the owner account (memoized in
// lib/user-scope.ts), falling back to the legacy singleton row so a DB where
// the owner can't be resolved still behaves exactly as before the rework.
export async function findGlobalSetting(): Promise<GlobalSetting | null> {
    const ownerId = await resolveOwnerUserId();
    if (ownerId) {
        const row = await prisma.globalSetting.findUnique({ where: { userId: ownerId } });
        if (row) return row;
    }
    return prisma.globalSetting.findUnique({ where: { id: 'global' } });
}

// Atomic conditional update keyed on the version column. Returns the new
// version on success, or the current server-side version on conflict so the
// client can refetch and reconcile. Bootstraps a fresh row on the user's
// first write (when they have no row yet) regardless of the expected version
// — same If-Match contract as the legacy single-row design.
export async function upsertGlobalSettingWithVersion(
    userId: string,
    serialized: Partial<GlobalSetting>,
    expectedVersion: number
): Promise<UpsertResult> {
    const updated = await prisma.globalSetting.updateMany({
        where: { userId, version: expectedVersion },
        data: { ...serialized, version: { increment: 1 } },
    });

    if (updated.count === 1) {
        return { ok: true, newVersion: expectedVersion + 1 };
    }

    // Either the row doesn't exist (bootstrap) or version mismatched.
    const current = await prisma.globalSetting.findUnique({ where: { userId } });
    if (!current) {
        try {
            const created = await prisma.globalSetting.create({
                data: { userId, ...serialized, version: 1 },
            });
            return { ok: true, newVersion: created.version };
        } catch {
            // Unique(userId) race: someone else bootstrapped between our read
            // and create — surface it as a version conflict so the client
            // refetches (same path as a concurrent-write mismatch).
            const raced = await prisma.globalSetting.findUnique({ where: { userId } });
            if (raced) return { ok: false, currentVersion: raced.version };
            throw new Error('GlobalSetting bootstrap failed');
        }
    }
    return { ok: false, currentVersion: current.version };
}

// Parse the `globalNegativeFilters` JSON column into the flat list.
// Accepts both legacy shapes: the original `["a","b"]` array and the
// intermediate `{"career":[...],"side":[...]}` per-track map (unions both
// buckets, dedupes case-insensitively). Next write persists the flat shape.
export function parseNegativeFilters(raw: string | null | undefined): string[] {
    if (!raw) return [];
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return []; }
    const pickArray = (v: unknown): string[] =>
        Array.isArray(v) ? v.filter((p): p is string => typeof p === "string") : [];
    let collected: string[];
    if (Array.isArray(parsed)) {
        collected = pickArray(parsed);
    } else if (parsed && typeof parsed === "object") {
        const obj = parsed as Record<string, unknown>;
        collected = [...pickArray(obj.career), ...pickArray(obj.side)];
    } else {
        return [];
    }
    const seen = new Set<string>();
    const out: string[] = [];
    for (const p of collected) {
        const key = normalizeNegativeFilterForDedup(p);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(p);
    }
    return out;
}

export function parseGlobalSetting(row: {
    isDarkMode: boolean;
    viewHuesEnabled: boolean;
    viewHues: string;
    dashOrder: string;
    dashTitles: string;
    globalNegativeFilters: string;
    hiddenWatchlistIds: string;
    version: number;
}): GlobalSettingData {
    return {
        isDarkMode: row.isDarkMode,
        viewHuesEnabled: row.viewHuesEnabled,
        viewHues: JSON.parse(row.viewHues),
        dashOrder: JSON.parse(row.dashOrder),
        dashTitles: JSON.parse(row.dashTitles),
        negativeFilters: parseNegativeFilters(row.globalNegativeFilters),
        hiddenWatchlistIds: parseStringArray(row.hiddenWatchlistIds),
        version: row.version,
    };
}

export function serializeGlobalSetting(data: Partial<GlobalSettingData>) {
    const out: Record<string, any> = {};
    if (data.isDarkMode !== undefined) out.isDarkMode = data.isDarkMode;
    if (data.viewHuesEnabled !== undefined) out.viewHuesEnabled = data.viewHuesEnabled;
    if (data.viewHues !== undefined) out.viewHues = JSON.stringify(data.viewHues);
    if (data.dashOrder !== undefined) out.dashOrder = JSON.stringify(data.dashOrder);
    if (data.dashTitles !== undefined) out.dashTitles = JSON.stringify(data.dashTitles);
    if (data.negativeFilters !== undefined) {
        // Always write the flat array, even when empty — an explicit clear is
        // a meaningful state, not a default to drop.
        out.globalNegativeFilters = JSON.stringify(data.negativeFilters);
    }
    if (data.hiddenWatchlistIds !== undefined) {
        // Empty is meaningful here too (the user un-hid everything).
        out.hiddenWatchlistIds = JSON.stringify(data.hiddenWatchlistIds);
    }
    return out;
}
