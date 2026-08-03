import { z } from 'zod';
import { regexShapeRisk } from '@/lib/schemas/regex-guard';

// ─── Entity shape ──────────────────────────────────────────────────────────
// Parsed (post-JSON) GlobalSettingData — mirrors lib/repositories/settings.ts
// after parseGlobalSetting() runs. `version` is the optimistic-concurrency
// counter; clients send it back as the If-Match header on POST.
// Single shared negative-filters list applied to every watchlist regardless
// of track. See lib/repositories/settings.ts for the legacy-shape migration.
//
// THE SAME ReDoS BOUND AS Watchlist.negativeFilters, and this list is the
// LARGER of the two — 40 patterns vs 20 — so it is the bigger half of the
// exposure, not the smaller. `/api/settings` POST is `requireSession`, so crew
// write here; every entry is compiled by lib/postings/negative-filters.ts and
// `.test()`ed once per posting row inside the /api/postings request path.
// Rationale + measurements: lib/schemas/regex-guard.ts.
//
// Shape-only (`regexShapeRisk`), NOT the compile gate — matching
// Watchlist.negativeFilters and preserving negative-filters.ts's documented
// "an invalid pattern is silently skipped" contract. Verified 2026-08-02
// against every pattern stored in prod.db and dev.db: all are plain keywords
// ("senior", "Sr.", "Lead", …) with no groups or quantifiers, so none is
// rejected and no user's next settings PATCH breaks on data they never edited.
export const NegativeFiltersListSchema = z.array(
    z.string().max(200).superRefine((value, ctx) => {
        const risk = regexShapeRisk(value);
        if (risk) ctx.addIssue({ code: 'custom', message: `Unsafe filter pattern "${value}" — ${risk}.` });
    }).describe(
        'Plain keyword or regex source, matched case-insensitively against title+snippet+location of ' +
        'every posting. Rejected when it has a catastrophic-backtracking shape (a repeated group that ' +
        'itself repeats or alternates, e.g. `(a+)+`) or uses a backreference. A pattern that simply ' +
        'does not compile is accepted and silently skipped at match time.',
    ),
).max(40);

// Watchlist IDs hidden from the postings feed. Cuids (~25 chars); cap is
// generous (a user could watch hundreds of companies). Defaulted in the GET
// shape below so a response from a server that predates the column still parses.
export const HiddenWatchlistIdsSchema = z.array(z.string().max(100)).max(1000);

export const SettingsDataSchema = z.object({
    isDarkMode: z.boolean(),
    viewHuesEnabled: z.boolean(),
    viewHues: z.record(z.string(), z.number()),
    dashOrder: z.array(z.string()),
    dashTitles: z.record(z.string(), z.string()),
    negativeFilters: NegativeFiltersListSchema,
    hiddenWatchlistIds: HiddenWatchlistIdsSchema.default([]),
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
    negativeFilters: NegativeFiltersListSchema.optional(),
    hiddenWatchlistIds: HiddenWatchlistIdsSchema.optional(),
});
