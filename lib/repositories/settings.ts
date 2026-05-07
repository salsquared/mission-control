import { prisma } from '@/lib/prisma';
import type { GlobalSetting } from '@prisma/client';

export interface GlobalSettingData {
    isDarkMode: boolean;
    viewHuesEnabled: boolean;
    viewHues: Record<string, number>;
    dashOrder: string[];
    dashTitles: Record<string, string>;
}

export function findGlobalSetting(): Promise<GlobalSetting | null> {
    return prisma.globalSetting.findUnique({ where: { id: 'global' } });
}

export async function upsertGlobalSetting(serialized: Partial<GlobalSetting>): Promise<void> {
    await prisma.globalSetting.upsert({
        where: { id: 'global' },
        update: serialized,
        create: { id: 'global', ...serialized },
    });
}

export function parseGlobalSetting(row: {
    isDarkMode: boolean;
    viewHuesEnabled: boolean;
    viewHues: string;
    dashOrder: string;
    dashTitles: string;
}): GlobalSettingData {
    return {
        isDarkMode: row.isDarkMode,
        viewHuesEnabled: row.viewHuesEnabled,
        viewHues: JSON.parse(row.viewHues),
        dashOrder: JSON.parse(row.dashOrder),
        dashTitles: JSON.parse(row.dashTitles),
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
