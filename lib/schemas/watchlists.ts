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
//   - smartrecruiters: api.smartrecruiters.com/v1/companies/<slug>/postings,
//     paginated (Visa, ServiceNow, Ubisoft, Bosch, McDonald's, IKEA).
//     Slugs are case-sensitive.
//   - workable: apply.workable.com/api/v1/widget/accounts/<slug>?details=true
//     (Workable itself, many 50–500-person companies). Returns all jobs in
//     one shot.
//   - recruitee: <slug>.recruitee.com/api/offers/ (mostly EU companies).
//     Returns all offers in one shot.
//   - personio: <slug>.jobs.personio.com/xml (Personio itself, lots of
//     European companies). XML sitemap-style feed, no pagination.
//   - clearcompany: careers-api.clearcompany.com/v1/<siteId> (Firefly
//     Aerospace and mid-market companies). siteId is a UUID, not a slug.
//   - linkedin: scrapes the public guest jobs-search endpoint with cheerio.
//     Fragile by design — LinkedIn aggressively bot-detects.
export const WATCHLIST_KINDS = [
    "careers-page", "greenhouse", "lever", "ashby", "workday",
    "smartrecruiters", "workable", "recruitee", "personio",
    "clearcompany",
    "linkedin",
] as const;
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
    // PB-ext-5: optional override of the per-crawl page cap. Defaults to 10
    // (200 postings) — fine for most tenants. Boeing has ~1,177 jobs and
    // Blue Origin ~957, so directory entries for those bump to 60 (= 1,200
    // posting cap, room for growth). Bounded [1, 200] so a typo can't
    // schedule a thousand HTTP round-trips per tick.
    maxPages: z.number().int().min(1).max(200).optional(),
});

export const SmartRecruitersConfigSchema = z.object({
    kind: z.literal("smartrecruiters"),
    // The company identifier from career-page URLs like
    // jobs.smartrecruiters.com/<slug> or careers.smartrecruiters.com/<slug>.
    // Case-sensitive — "Visa" works, "visa" returns 0.
    boardSlug: z.string().min(1).max(100),
    companyName: z.string().min(1),
    // Optional override of the per-crawl page cap. Default 5 (=500 postings at
    // limit=100). ServiceNow has ~480, Visa ~25 — most fit comfortably.
    maxPages: z.number().int().min(1).max(50).optional(),
});

export const WorkableConfigSchema = z.object({
    kind: z.literal("workable"),
    // The subdomain on apply.workable.com (e.g. "careers" for Workable's
    // own board → apply.workable.com/careers).
    boardSlug: z.string().min(1).max(100),
    companyName: z.string().min(1),
});

export const RecruiteeConfigSchema = z.object({
    kind: z.literal("recruitee"),
    // The subdomain on recruitee.com (e.g. "jet" → jet.recruitee.com).
    boardSlug: z.string().min(1).max(100),
    companyName: z.string().min(1),
});

export const PersonioConfigSchema = z.object({
    kind: z.literal("personio"),
    // The subdomain on jobs.personio.com (e.g. "personio" →
    // personio.jobs.personio.com).
    boardSlug: z.string().min(1).max(100),
    companyName: z.string().min(1),
});

export const ClearCompanyConfigSchema = z.object({
    kind: z.literal("clearcompany"),
    // siteId is a UUID — careers-api.clearcompany.com/v1/<siteId>. Extractable
    // from the careers page's embedded
    //   careers-content.clearcompany.com/js/v1/career-site.js?siteId=<uuid>
    // script tag. Stored as `boardSlug` to mirror every other slug-based
    // config and keep `watchlistConfigKey` / hydration uniform across kinds.
    boardSlug: z.string().min(20).max(100),
    companyName: z.string().min(1),
});

export const LinkedinConfigSchema = z.object({
    kind: z.literal("linkedin"),
    // Free-text keyword query (matches what a user would type in LinkedIn's
    // job search bar).
    keywords: z.string().min(1).max(200),
    // Optional location filter (e.g. "Remote", "United States", "New York").
    location: z.string().max(100).optional(),
    // Time window for the LinkedIn `f_TPR` filter. Recurring watchlist crawls
    // default to "24h" (keep deltas small, don't keep re-finding the same
    // week-old postings). One-shot discovery diagnostics should pass "week"
    // or wider. Omit to use the fetcher's default ("24h").
    timeRange: z.enum(["24h", "week", "month", "any"]).optional(),
    companyName: z.string().min(1),
});

export const WatchlistConfigSchema = z.discriminatedUnion("kind", [
    CareersPageConfigSchema,
    GreenhouseConfigSchema,
    LeverConfigSchema,
    AshbyConfigSchema,
    WorkdayConfigSchema,
    SmartRecruitersConfigSchema,
    WorkableConfigSchema,
    RecruiteeConfigSchema,
    PersonioConfigSchema,
    ClearCompanyConfigSchema,
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

// MB Phase 4 — pipeline track. "career" = long-term professional pursuit
// (kept on the main kanban); "side" = gig / blue-collar / pay-the-bills work
// (segregated into its own kanban + discovery section on ApplicationsView).
// Both are crawled the same way; the field is metadata for UI filtering.
export const WATCHLIST_TRACKS = ["career", "side"] as const;
export const WatchlistTrackSchema = z.enum(WATCHLIST_TRACKS);

export const WatchlistSchema = z.object({
    id: z.string(),
    userId: z.string(),
    name: z.string(),
    kind: WatchlistKindSchema,
    config: WatchlistConfigSchema,
    // PB-14: when non-null, names a COMPANY_DIRECTORY entry. The config field
    // is hydrated from that entry at read time. Wire reads only — clients
    // don't write to this field directly; they pass it on POST.
    directoryKey: z.string().nullable(),
    negativeFilters: z.array(z.string()).default([]),
    notificationMode: WatchlistNotificationModeSchema.default("each"),
    lastDigestAt: z.string().datetime().nullable(),
    scheduleMinutes: z.number().int().positive(),
    lastRunAt: z.string().datetime().nullable(),
    lastSuccessAt: z.string().datetime().nullable(),
    lastError: z.string().nullable(),
    active: z.boolean(),
    track: WatchlistTrackSchema.default("career"),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
});

export type WatchlistWire = z.infer<typeof WatchlistSchema>;

export const JOB_POSTING_STATUSES = ["new", "tracked", "hidden", "closed"] as const;
export const JobPostingStatusSchema = z.enum(JOB_POSTING_STATUSES);

// PB-15: small fixed enum kept in sync with lib/fetchers/employment-type.ts.
// Don't import from there to keep this schema independently parseable on the
// client (the helper module pulls in fetcher-only deps transitively).
export const EMPLOYMENT_TYPE_VALUES = ["full-time", "part-time", "internship", "contract", "temporary"] as const;
export const EmploymentTypeSchema = z.enum(EMPLOYMENT_TYPE_VALUES);

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
    employmentType: EmploymentTypeSchema.nullable(),
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
    // 240 = 4 hours. Aggregator APIs (Greenhouse / Lever / Ashby / Workday)
    // tolerate hourly polling, but real-world posting cadence is daily-ish for
    // most employers — checking every 4h is plenty without burning quota, and
    // LinkedIn's guest endpoint bot-detects more aggressively than the
    // structured ATSes do. UI exposes this as an hours-stepper.
    scheduleMinutes: z.number().int().positive().default(240),
    notificationMode: WatchlistNotificationModeSchema.default("each"),
    // PB-14: when the row originates from the "Watch company" picker, the
    // client passes the directory entry's `name`. Server hydrates `config`
    // from that entry on every read so directory edits propagate to existing
    // rows. Omit for the "Find roles" / "Advanced" tabs. Bounded length is
    // defense-in-depth: an unmatched key gets normalized to null on resolve,
    // but we still don't want to persist arbitrarily-large strings.
    directoryKey: z.string().min(1).max(100).nullable().optional(),
    track: WatchlistTrackSchema.default("career"),
});

export const WatchlistPatchSchema = z.object({
    name: z.string().min(1).optional(),
    config: WatchlistConfigSchema.optional(),
    negativeFilters: NegativeFiltersSchema.optional(),
    notificationMode: WatchlistNotificationModeSchema.optional(),
    scheduleMinutes: z.number().int().positive().optional(),
    active: z.boolean().optional(),
    track: WatchlistTrackSchema.optional(),
}).refine(d =>
    d.name !== undefined ||
    d.config !== undefined ||
    d.negativeFilters !== undefined ||
    d.notificationMode !== undefined ||
    d.scheduleMinutes !== undefined ||
    d.active !== undefined ||
    d.track !== undefined,
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
