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
    // Whether a manual builder selection exists (docs/resume-manual-builder.html);
    // derived from Canon.selection != null. The full selection loads via
    // GET /api/canons/[id]/selection — kept off the list payload to stay light.
    hasSelection: z.boolean(),
    // How many canonical versions exist (derived; convenience for the UI).
    versionCount: z.number().int().nonnegative(),
    active: z.boolean(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
});

export type CanonWire = z.infer<typeof CanonSchema>;

// ─── Manual builder selection (docs/resume-manual-builder.html) ──────────────
// The hand-curated, per-Canon resume selection persisted on Canon.selection
// (JSON). Replaces the keyword auto-selector for canon generation (OQ4/OQ15).

export const SELECTION_SECTION_KEYS = [
    "experience",
    "projects",
    "education",
    "skills",
    "languages",
    "interests",
] as const;
export const SelectionSectionKeySchema = z.enum(SELECTION_SECTION_KEYS);
export type SelectionSectionKey = z.infer<typeof SelectionSectionKeySchema>;

export const SELECTION_ENTITY_KINDS = ["workRole", "project", "education"] as const;
export const SelectionEntityKindSchema = z.enum(SELECTION_ENTITY_KINDS);

// One included entity: which kind + the bullet ids that render. Bullet order is
// the profile's order in v1 (OQ8); bulletIds is a membership set here.
export const CanonSelectionEntrySchema = z.object({
    kind: SelectionEntityKindSchema,
    bulletIds: z.array(z.string()).default([]),
});

export const CanonSelectionExtrasSchema = z.object({
    skillItems: z.array(z.string()).default([]),
    languages: z.array(z.string()).default([]),
    hobbies: z.array(z.string()).default([]),
});

// The full manual selection (Canon.selection JSON; also the PUT request body).
// Binary: an entity present in `entities` is included, one absent is not.
// `excluded` records deliberate excludes (OQ5=B) — inert in v1, forward-compat.
export const CanonSelectionSchema = z.object({
    version: z.number().int().min(1).default(1),
    sectionOrder: z.array(SelectionSectionKeySchema).default([...SELECTION_SECTION_KEYS]),
    sectionsOff: z.array(SelectionSectionKeySchema).default([]),
    entities: z.record(z.string(), CanonSelectionEntrySchema).default({}),
    excluded: z.array(z.string()).default([]),
    extras: CanonSelectionExtrasSchema.default({ skillItems: [], languages: [], hobbies: [] }),
});
export type CanonSelection = z.infer<typeof CanonSelectionSchema>;
export type CanonSelectionEntry = z.infer<typeof CanonSelectionEntrySchema>;

// PUT /api/canons/[id]/selection request body — the full selection.
export const CanonSelectionPutSchema = CanonSelectionSchema;
export type CanonSelectionPutInput = z.infer<typeof CanonSelectionPutSchema>;

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
