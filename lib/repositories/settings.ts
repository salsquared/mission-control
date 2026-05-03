export interface GlobalSettingData {
    isDarkMode: boolean;
    viewHuesEnabled: boolean;
    viewHues: Record<string, number>;
    dashOrder: string[];
    dashTitles: Record<string, string>;
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
