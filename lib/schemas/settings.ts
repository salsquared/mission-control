import { z } from 'zod';

// ─── Entity shape ──────────────────────────────────────────────────────────
// Parsed (post-JSON) GlobalSettingData — mirrors lib/repositories/settings.ts
// after parseGlobalSetting() runs. `version` is the optimistic-concurrency
// counter; clients send it back as the If-Match header on POST.
// Per-track negative filters — see lib/repositories/settings.ts comment.
// Each track has its own list so the career and side WatchlistsCard
// instances edit independent blocklists.
export const NegativeFiltersByTrackSchema = z.object({
    career: z.array(z.string().max(200)).max(20),
    side: z.array(z.string().max(200)).max(20),
});

export const SettingsDataSchema = z.object({
    isDarkMode: z.boolean(),
    viewHuesEnabled: z.boolean(),
    viewHues: z.record(z.string(), z.number()),
    dashOrder: z.array(z.string()),
    dashTitles: z.record(z.string(), z.string()),
    negativeFiltersByTrack: NegativeFiltersByTrackSchema,
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
    negativeFiltersByTrack: NegativeFiltersByTrackSchema.optional(),
});
