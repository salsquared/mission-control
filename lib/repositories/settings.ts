import { prisma } from '@/lib/prisma';
import type { GlobalSetting } from '@prisma/client';

export interface GlobalSettingData {
    isDarkMode: boolean;
    viewHuesEnabled: boolean;
    viewHues: Record<string, number>;
    dashOrder: string[];
    dashTitles: Record<string, string>;
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

export function parseGlobalSetting(row: {
    isDarkMode: boolean;
    viewHuesEnabled: boolean;
    viewHues: string;
    dashOrder: string;
    dashTitles: string;
    version: number;
}): GlobalSettingData {
    return {
        isDarkMode: row.isDarkMode,
        viewHuesEnabled: row.viewHuesEnabled,
        viewHues: JSON.parse(row.viewHues),
        dashOrder: JSON.parse(row.dashOrder),
        dashTitles: JSON.parse(row.dashTitles),
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
    return out;
}
