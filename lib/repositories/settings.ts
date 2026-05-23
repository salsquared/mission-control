import { prisma } from '@/lib/prisma';
import type { GlobalSetting } from '@prisma/client';

// Negative filters are stored on a single `globalNegativeFilters` JSON
// column (legacy name kept to avoid a prisma migration). The in-memory
// shape is per-track so career/side WatchlistsCard instances can each
// edit their own list — see WatchlistsCard's FilterButton. Parser below
// migrates legacy array values into the `career` bucket on read.
export type NegativeFilterTrack = "career" | "side";
export type NegativeFiltersByTrack = Record<NegativeFilterTrack, string[]>;

export const EMPTY_NEGATIVE_FILTERS: NegativeFiltersByTrack = { career: [], side: [] };

export interface GlobalSettingData {
    isDarkMode: boolean;
    viewHuesEnabled: boolean;
    viewHues: Record<string, number>;
    dashOrder: string[];
    dashTitles: Record<string, string>;
    negativeFiltersByTrack: NegativeFiltersByTrack;
    version: number;
}

export type UpsertResult =
    | { ok: true; newVersion: number }
    | { ok: false; currentVersion: number };

export function findGlobalSetting(): Promise<GlobalSetting | null> {
    return prisma.globalSetting.findUnique({ where: { id: 'global' } });
}

// Atomic conditional update keyed on the version column. Returns the new
// version on success, or the current server-side version on conflict so the
// client can refetch and reconcile. Bootstraps a fresh row on first write
// (when no row exists) regardless of the expected version.
export async function upsertGlobalSettingWithVersion(
    serialized: Partial<GlobalSetting>,
    expectedVersion: number
): Promise<UpsertResult> {
    const updated = await prisma.globalSetting.updateMany({
        where: { id: 'global', version: expectedVersion },
        data: { ...serialized, version: { increment: 1 } },
    });

    if (updated.count === 1) {
        return { ok: true, newVersion: expectedVersion + 1 };
    }

    // Either the row doesn't exist (bootstrap) or version mismatched.
    const current = await prisma.globalSetting.findUnique({ where: { id: 'global' } });
    if (!current) {
        const created = await prisma.globalSetting.create({
            data: { id: 'global', ...serialized, version: 1 },
        });
        return { ok: true, newVersion: created.version };
    }
    return { ok: false, currentVersion: current.version };
}

// Parse the `globalNegativeFilters` JSON column into the per-track map.
// Accepts the legacy `["a","b"]` shape (promotes to the career bucket — the
// original use case) and the new `{"career":[...],"side":[...]}` shape.
// Any pre-existing user data lands under `career` on first read, then the
// next write persists the new shape.
export function parseNegativeFiltersByTrack(raw: string | null | undefined): NegativeFiltersByTrack {
    if (!raw) return { career: [], side: [] };
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return { career: [], side: [] }; }
    if (Array.isArray(parsed)) {
        return {
            career: parsed.filter((p): p is string => typeof p === "string"),
            side: [],
        };
    }
    if (parsed && typeof parsed === "object") {
        const obj = parsed as Record<string, unknown>;
        const pickArray = (v: unknown): string[] =>
            Array.isArray(v) ? v.filter((p): p is string => typeof p === "string") : [];
        return { career: pickArray(obj.career), side: pickArray(obj.side) };
    }
    return { career: [], side: [] };
}

export function parseGlobalSetting(row: {
    isDarkMode: boolean;
    viewHuesEnabled: boolean;
    viewHues: string;
    dashOrder: string;
    dashTitles: string;
    globalNegativeFilters: string;
    version: number;
}): GlobalSettingData {
    return {
        isDarkMode: row.isDarkMode,
        viewHuesEnabled: row.viewHuesEnabled,
        viewHues: JSON.parse(row.viewHues),
        dashOrder: JSON.parse(row.dashOrder),
        dashTitles: JSON.parse(row.dashTitles),
        negativeFiltersByTrack: parseNegativeFiltersByTrack(row.globalNegativeFilters),
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
    if (data.negativeFiltersByTrack !== undefined) {
        // Always write the new per-track shape, even if both tracks are empty —
        // future reads stay consistent. Don't drop empty arrays; the editor
        // round-trips them to mean "user explicitly cleared this track".
        out.globalNegativeFilters = JSON.stringify(data.negativeFiltersByTrack);
    }
    return out;
}
