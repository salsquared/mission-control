import { z } from "zod";

// Source types:
//   - careers-page: scrape an HTML page with cheerio + a link regex (small set
//     of companies that still serve static HTML).
//   - greenhouse: boards-api.greenhouse.io/v1/boards/<slug>/jobs (Anthropic,
//     Stripe, Rocket Lab, Vercel, ...).
//   - lever: api.lever.co/v0/postings/<slug> (Spotify, Lever's own boards,
//     many YC companies).
//   - ashby: api.ashbyhq.com/posting-api/job-board/<slug> (Notion, PostHog,
//     many AI-era companies).
//   - workday: per-tenant POST to <tenantHost>/wday/cxs/<slug>/<careerSite>/jobs
//     (Boeing, Blue Origin, most legacy enterprises).
//   - linkedin: scrapes the public guest jobs-search endpoint with cheerio.
//     Fragile by design — LinkedIn aggressively bot-detects.
export const WATCHLIST_KINDS = ["careers-page", "greenhouse", "lever", "ashby", "workday", "linkedin"] as const;
export const WatchlistKindSchema = z.enum(WATCHLIST_KINDS);

export const CareersPageConfigSchema = z.object({
    kind: z.literal("careers-page"),
    rootUrl: z.string().url(),
    // regex source; bounded length is a cheap defense against ReDoS — short
    // patterns can still be catastrophic but the realistic worst case is much
    // smaller than what arbitrary-length input allows.
    linkPattern: z.string().min(1).max(200),
    companyName: z.string().min(1),
    location: z.string().optional(),
});

export const GreenhouseConfigSchema = z.object({
    kind: z.literal("greenhouse"),
    boardSlug: z.string().min(1), // the boards-api.greenhouse.io/v1/boards/<slug> slug
    companyName: z.string().min(1),
});

export const LeverConfigSchema = z.object({
    kind: z.literal("lever"),
    boardSlug: z.string().min(1), // the api.lever.co/v0/postings/<slug> slug
    companyName: z.string().min(1),
});

export const AshbyConfigSchema = z.object({
    kind: z.literal("ashby"),
    boardSlug: z.string().min(1), // the api.ashbyhq.com/posting-api/job-board/<slug> slug
    companyName: z.string().min(1),
});

export const WorkdayConfigSchema = z.object({
    kind: z.literal("workday"),
    // e.g. "boeing.wd1.myworkdayjobs.com" or "blueorigin.wd5.myworkdayjobs.com"
    tenantHost: z.string().min(1).regex(/^[a-z0-9-]+\.wd\d+\.myworkdayjobs\.com$/i, {
        message: "Expected <tenant>.wd<N>.myworkdayjobs.com (the host of the public Workday careers page)",
    }),
    // e.g. "EXTERNAL_CAREERS" (Boeing) or "BlueOrigin" (Blue Origin). The path
    // segment after the host on the public careers page.
    careerSite: z.string().min(1).regex(/^[A-Za-z0-9_-]+$/),
    companyName: z.string().min(1),
});

export const LinkedinConfigSchema = z.object({
    kind: z.literal("linkedin"),
    // Free-text keyword query (matches what a user would type in LinkedIn's
    // job search bar).
    keywords: z.string().min(1).max(200),
    // Optional location filter (e.g. "Remote", "United States", "New York").
    location: z.string().max(100).optional(),
    companyName: z.string().min(1),
});

export const WatchlistConfigSchema = z.discriminatedUnion("kind", [
    CareersPageConfigSchema,
    GreenhouseConfigSchema,
    LeverConfigSchema,
    AshbyConfigSchema,
    WorkdayConfigSchema,
    LinkedinConfigSchema,
]);

export type WatchlistConfig = z.infer<typeof WatchlistConfigSchema>;

// ─── Entity ───────────────────────────────────────────────────────────────

// Negative filters: array of regex patterns. The watchlist hides any
// posting whose (title + snippet + location) matches any pattern at the
// /api/postings GET layer.
const MAX_NEGATIVE_FILTERS = 20;
const MAX_NEGATIVE_FILTER_LEN = 200;
export const NegativeFiltersSchema = z.array(
    z.string().min(1).max(MAX_NEGATIVE_FILTER_LEN),
).max(MAX_NEGATIVE_FILTERS);

// Story 26 — per-watchlist notification preference. "each" fires per-posting,
// "digest" rolls into one summary via the posting-digest scheduler job,
// "silent" skips notifications entirely (postings still appear in the feed).
export const WATCHLIST_NOTIFICATION_MODES = ["each", "digest", "silent"] as const;
export const WatchlistNotificationModeSchema = z.enum(WATCHLIST_NOTIFICATION_MODES);

export const WatchlistSchema = z.object({
    id: z.string(),
    userId: z.string(),
    name: z.string(),
    kind: WatchlistKindSchema,
    config: WatchlistConfigSchema,
    negativeFilters: z.array(z.string()).default([]),
    notificationMode: WatchlistNotificationModeSchema.default("each"),
    lastDigestAt: z.string().datetime().nullable(),
    scheduleMinutes: z.number().int().positive(),
    lastRunAt: z.string().datetime().nullable(),
    lastSuccessAt: z.string().datetime().nullable(),
    lastError: z.string().nullable(),
    active: z.boolean(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
});

export type WatchlistWire = z.infer<typeof WatchlistSchema>;

export const JOB_POSTING_STATUSES = ["new", "tracked", "hidden", "closed"] as const;
export const JobPostingStatusSchema = z.enum(JOB_POSTING_STATUSES);

export const JobPostingSchema = z.object({
    id: z.string(),
    watchlistId: z.string(),
    externalId: z.string(),
    company: z.string(),
    title: z.string(),
    location: z.string().nullable(),
    postedAt: z.string().datetime().nullable(),
    snippet: z.string().nullable(),
    sourceUrl: z.string(),
    status: JobPostingStatusSchema,
    firstSeenAt: z.string().datetime(),
    lastSeenAt: z.string().datetime(),
    removedAt: z.string().datetime().nullable(),
});

export type JobPostingWire = z.infer<typeof JobPostingSchema>;

// ─── Requests ──────────────────────────────────────────────────────────────

export const WatchlistPostSchema = z.object({
    name: z.string().min(1),
    config: WatchlistConfigSchema,
    scheduleMinutes: z.number().int().positive().default(30),
    notificationMode: WatchlistNotificationModeSchema.default("each"),
});

export const WatchlistPatchSchema = z.object({
    name: z.string().min(1).optional(),
    config: WatchlistConfigSchema.optional(),
    negativeFilters: NegativeFiltersSchema.optional(),
    notificationMode: WatchlistNotificationModeSchema.optional(),
    scheduleMinutes: z.number().int().positive().optional(),
    active: z.boolean().optional(),
}).refine(d =>
    d.name !== undefined ||
    d.config !== undefined ||
    d.negativeFilters !== undefined ||
    d.notificationMode !== undefined ||
    d.scheduleMinutes !== undefined ||
    d.active !== undefined,
    { message: "At least one mutable field must be provided" },
);

export const JobPostingPatchSchema = z.object({
    status: JobPostingStatusSchema,
});

// ─── Responses ─────────────────────────────────────────────────────────────

export const WatchlistsListResponseSchema = z.object({
    watchlists: z.array(WatchlistSchema),
});

export const WatchlistMutationResponseSchema = z.object({
    watchlist: WatchlistSchema,
});

export const PostingsListResponseSchema = z.object({
    postings: z.array(JobPostingSchema),
});

export const PostingMutationResponseSchema = z.object({
    posting: JobPostingSchema,
});

export const WatchlistRunResponseSchema = z.object({
    watchlistId: z.string(),
    newPostings: z.number().int(),
    seenAgain: z.number().int(),
    closed: z.number().int(),
    error: z.string().nullable(),
});
