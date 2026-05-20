import { z } from 'zod';

// ─── Entity shape ──────────────────────────────────────────────────────────
// Parsed (post-JSON) GlobalSettingData — mirrors lib/repositories/settings.ts
// after parseGlobalSetting() runs. `version` is the optimistic-concurrency
// counter; clients send it back as the If-Match header on POST.
export const SettingsDataSchema = z.object({
    isDarkMode: z.boolean(),
    viewHuesEnabled: z.boolean(),
    viewHues: z.record(z.string(), z.number()),
    dashOrder: z.array(z.string()),
    dashTitles: z.record(z.string(), z.string()),
    globalNegativeFilters: z.array(z.string()),
    version: z.number().int(),
});

// ─── Responses ─────────────────────────────────────────────────────────────
export const SettingsGetResponseSchema = z.object({
    data: SettingsDataSchema.nullable(),
});

export const SettingsPostResponseSchema = z.object({
    success: z.literal(true),
    version: z.number().int(),
});

export const SettingsPostConflictSchema = z.object({
    error: z.string(),
    currentVersion: z.number().int(),
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
    globalNegativeFilters: z.array(z.string().max(200)).max(20).optional(),
});
