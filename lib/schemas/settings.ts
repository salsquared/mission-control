import { z } from 'zod';

// ─── Entity shape ──────────────────────────────────────────────────────────
// Parsed (post-JSON) GlobalSettingData — mirrors lib/repositories/settings.ts
// after parseGlobalSetting() runs.
export const SettingsDataSchema = z.object({
    isDarkMode: z.boolean(),
    viewHuesEnabled: z.boolean(),
    viewHues: z.record(z.string(), z.number()),
    dashOrder: z.array(z.string()),
    dashTitles: z.record(z.string(), z.string()),
});

// ─── Responses ─────────────────────────────────────────────────────────────
export const SettingsGetResponseSchema = z.object({
    data: SettingsDataSchema.nullable(),
});

export const SettingsPostResponseSchema = z.object({
    success: z.literal(true),
});

// ─── Requests ──────────────────────────────────────────────────────────────
// Mirrors the GlobalSettingData type in lib/repositories/settings.ts. Every
// field is optional because the route accepts partial updates.
export const SettingsPostSchema = z.object({
    isDarkMode: z.boolean().optional(),
    viewHuesEnabled: z.boolean().optional(),
    viewHues: z.record(z.string(), z.number()).optional(),
    dashOrder: z.array(z.string()).optional(),
    dashTitles: z.record(z.string(), z.string()).optional(),
});
