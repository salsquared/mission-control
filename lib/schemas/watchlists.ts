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
// Phase 2b will add workday + linkedin.
export const WATCHLIST_KINDS = ["careers-page", "greenhouse", "lever", "ashby"] as const;
export const WatchlistKindSchema = z.enum(WATCHLIST_KINDS);

export const CareersPageConfigSchema = z.object({
    kind: z.literal("careers-page"),
    rootUrl: z.string().url(),
    linkPattern: z.string().min(1), // regex source
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

export const WatchlistConfigSchema = z.discriminatedUnion("kind", [
    CareersPageConfigSchema,
    GreenhouseConfigSchema,
    LeverConfigSchema,
    AshbyConfigSchema,
]);

export type WatchlistConfig = z.infer<typeof WatchlistConfigSchema>;

// ─── Entity ───────────────────────────────────────────────────────────────

export const WatchlistSchema = z.object({
    id: z.string(),
    userId: z.string(),
    name: z.string(),
    kind: WatchlistKindSchema,
    config: WatchlistConfigSchema,
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
});

export const WatchlistPatchSchema = z.object({
    name: z.string().min(1).optional(),
    config: WatchlistConfigSchema.optional(),
    scheduleMinutes: z.number().int().positive().optional(),
    active: z.boolean().optional(),
}).refine(d =>
    d.name !== undefined ||
    d.config !== undefined ||
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
