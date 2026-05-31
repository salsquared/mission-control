import { z } from "zod";

// Canonical resumes ("Canons") — docs/canonical-resumes.html. A Canon is a
// user-named role-archetype that owns one reusable resume. This module is the
// API contract: the repository, the routes, and the Profile-view UI all build
// against these shapes.

// MB Phase 4 tracks, reused — a canon nests under exactly one track (§6 Q2).
export const CANON_TRACKS = ["career", "side"] as const;
export const CanonTrackSchema = z.enum(CANON_TRACKS);

// Bounds: keyword text is small free text (a watchlist OR-string or a typed
// list), not a document — 4 KB is generous. Name is a short label.
const NAME_MAX = 120;
const KEYWORDS_MAX = 4000;
const DESCRIPTION_MAX = 1000;

// ─── Entity (wire) ──────────────────────────────────────────────────────────

export const CanonSchema = z.object({
    id: z.string(),
    userId: z.string(),
    name: z.string(),
    slug: z.string(),
    track: CanonTrackSchema,
    description: z.string().nullable(),
    // Raw user keyword text (split into a flat term array at gen time).
    keywords: z.string(),
    // Render default = PDF + one-page (§6 Q9).
    onePage: z.boolean(),
    // Active (latest) canon resume version, or null before the first generate.
    currentResumeId: z.string().nullable(),
    // Demand-driven, entity-scoped staleness (§6 Q7).
    resumeStale: z.boolean(),
    // The staleness dependency set — profile entity ids in the current resume's
    // selection. Parsed from the stored JSON by the repository.
    resumeEntityIds: z.array(z.string()),
    // How many canonical versions exist (derived; convenience for the UI).
    versionCount: z.number().int().nonnegative(),
    active: z.boolean(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
});

export type CanonWire = z.infer<typeof CanonSchema>;

// ─── Requests ──────────────────────────────────────────────────────────────

export const CanonPostSchema = z.object({
    name: z.string().min(1).max(NAME_MAX),
    track: CanonTrackSchema,
    keywords: z.string().max(KEYWORDS_MAX).default(""),
    description: z.string().max(DESCRIPTION_MAX).optional(),
    // Defaults to true server-side (§6 Q9) when omitted.
    onePage: z.boolean().optional(),
});

export type CanonPostInput = z.infer<typeof CanonPostSchema>;

// Track is intentionally NOT patchable — a canon's track is fixed at creation
// (§6 Q2). Everything else is editable.
export const CanonPatchSchema = z
    .object({
        name: z.string().min(1).max(NAME_MAX).optional(),
        keywords: z.string().max(KEYWORDS_MAX).optional(),
        description: z.string().max(DESCRIPTION_MAX).nullable().optional(),
        onePage: z.boolean().optional(),
        active: z.boolean().optional(),
    })
    .refine((d) => Object.values(d).some((v) => v !== undefined), {
        message: "At least one mutable field must be provided",
    });

export type CanonPatchInput = z.infer<typeof CanonPatchSchema>;

// ─── Responses ─────────────────────────────────────────────────────────────

export const CanonsListResponseSchema = z.object({
    canons: z.array(CanonSchema),
});

export const CanonMutationResponseSchema = z.object({
    canon: CanonSchema,
});
