import { z } from 'zod';
import { LANGUAGE_PROFICIENCIES } from '@/lib/profile/types';
// Re-export so existing importers (api-client, etc.) keep working without
// pulling in the rest of lib/profile/types.
export { LANGUAGE_PROFICIENCIES };

// ─── Bullet ────────────────────────────────────────────────────────────────
// Mirrors lib/profile/types.ts:Bullet. When *writing*, id is optional so a
// brand-new bullet can be created without the client minting an id first;
// normalizeBullet() in lib/profile/bullets.ts stamps one server-side.
//
// M8.5.1 added `autoTags` (subset of `tags` pending user review — Decision 6.3)
// and `removedTags` (per-bullet blocklist for the auto-tag pass — Decision 6.1).
// M7.7.1 added `pinnedTags` (story S7.11): user-anchored tags that survive
// both the per-bullet AI-tag generator (S7.10) and the bulk auto-tag pass.
// All three .default([]) on the canonical schema so bullets parsed from JSON
// written before this migration still validate.
export const BulletSchema = z.object({
    id: z.string(),
    text: z.string(),
    tags: z.array(z.string()),
    autoTags: z.array(z.string()).default([]),
    removedTags: z.array(z.string()).default([]),
    pinnedTags: z.array(z.string()).default([]),
    locked: z.boolean(),
    excluded: z.boolean(),
});

export const BulletWriteSchema = z.object({
    id: z.string().optional(),
    text: z.string().min(1),
    tags: z.array(z.string()).optional(),
    autoTags: z.array(z.string()).optional(),
    removedTags: z.array(z.string()).optional(),
    pinnedTags: z.array(z.string()).optional(),
    locked: z.boolean().optional(),
    excluded: z.boolean().optional(),
}).refine(
    (b) => {
        // Invariant: a tag cannot appear in both `tags` and `removedTags` in
        // the same write. Vacuously true when either side is omitted; the
        // route's merge layer enforces it across the merged state.
        if (!b.tags || !b.removedTags) return true;
        const tagSet = new Set(b.tags);
        return !b.removedTags.some((t) => tagSet.has(t));
    },
    { message: 'A tag cannot appear in both `tags` and `removedTags`' }
).refine(
    (b) => {
        // M7.7.1 invariant: every pinned tag must currently be applied.
        // Vacuously true when either side is omitted. The UI clears the pin
        // when the user removes a tag (M7.7.6), so this only trips on
        // hand-rolled / out-of-date payloads.
        if (!b.pinnedTags || !b.tags) return true;
        const tagSet = new Set(b.tags);
        return b.pinnedTags.every((t) => tagSet.has(t));
    },
    { message: 'Every entry in `pinnedTags` must also appear in `tags`' }
).refine(
    (b) => {
        // M7.7.1 invariant: blocklist wins — a tag in `removedTags` cannot
        // also be pinned. Pinning a blocked tag is rejected so the user
        // can't accidentally re-introduce a tag they've explicitly removed.
        if (!b.pinnedTags || !b.removedTags) return true;
        const removedSet = new Set(b.removedTags);
        return !b.pinnedTags.some((t) => removedSet.has(t));
    },
    { message: 'A tag cannot appear in both `pinnedTags` and `removedTags`' }
).transform((b) => ({
    // M8.5.6 Decision 6.3 implicit-accept-on-save: every successful PATCH
    // through this schema zeros out `autoTags`. The LLM-suggested keywords
    // ride alongside `tags` while the user reviews them in the UI; the next
    // save folds them in as regular tags. The UI also clears autoTags
    // optimistically (mirrors this behavior), but the server is the source
    // of truth — any client that forgets to clear, or hand-rolled curl
    // calls, still get the right semantic here.
    ...b,
    autoTags: [] as string[],
}));

// Optional link entry (Profile.links is a JSON array of these).
export const ProfileLinkSchema = z.object({
    label: z.string(),
    url: z.string().url(),
});

// Profile.skills: user-defined groups, each a category label + flat string items.
export const SkillGroupSchema = z.object({
    category: z.string().min(1),
    items: z.array(z.string().min(1)),
});

export const LanguageProficiencySchema = z.enum(LANGUAGE_PROFICIENCIES);
export const LanguageEntrySchema = z.object({
    name: z.string().min(1),
    proficiency: LanguageProficiencySchema,
});

// ─── Entity shapes (responses include parsed bullets, not the JSON string) ──
// `scratchpad` is .nullable().optional() so pre-M7.8.1 snapshots and fixtures
// validate without spelling out a null. Server reads always emit the column
// explicitly (null when unset).
export const WorkRoleSchema = z.object({
    id: z.string(),
    profileId: z.string(),
    company: z.string(),
    title: z.string(),
    location: z.string().nullable(),
    startDate: z.string().datetime(),
    endDate: z.string().datetime().nullable(),
    bullets: z.array(BulletSchema),
    scratchpad: z.string().nullable().optional(),
    position: z.number().int(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
});

export const ProjectSchema = z.object({
    id: z.string(),
    profileId: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    repoUrl: z.string().nullable(),
    liveUrl: z.string().nullable(),
    bullets: z.array(BulletSchema),
    metrics: z.unknown().nullable(),
    githubRepo: z.string().nullable(),
    portfolio: z.boolean(),
    metricsUpdatedAt: z.string().datetime().nullable(),
    // Story S9.5 — README markdown ingested for portfolio repos. Truncated at
    // 16 KB at write time; the resume rewrite prompt slices an additional
    // 2 KB excerpt per project. NULL when no README has been fetched yet
    // (or the repo has no README).
    readme: z.string().nullable().optional(),
    readmeUpdatedAt: z.string().datetime().nullable().optional(),
    scratchpad: z.string().nullable().optional(),
    position: z.number().int(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
});

export const EducationSchema = z.object({
    id: z.string(),
    profileId: z.string(),
    institution: z.string(),
    degree: z.string().nullable(),
    field: z.string().nullable(),
    startDate: z.string().datetime().nullable(),
    endDate: z.string().datetime().nullable(),
    bullets: z.array(BulletSchema),
    scratchpad: z.string().nullable().optional(),
    position: z.number().int(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
});

export const ProfileSchema = z.object({
    id: z.string(),
    userId: z.string(),
    headline: z.string().nullable(),
    summary: z.string().nullable(),
    location: z.string().nullable(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
    links: z.array(ProfileLinkSchema).nullable(),
    // Optional on the wire so fixtures and pre-migration snapshots don't need
    // to spell out a null. Server always sets these explicitly when serializing
    // a live profile, so production reads still arrive populated.
    skills: z.array(SkillGroupSchema).nullable().optional(),
    hobbies: z.array(z.string()).nullable().optional(),
    languages: z.array(LanguageEntrySchema).nullable().optional(),
    workRoles: z.array(WorkRoleSchema),
    projects: z.array(ProjectSchema),
    education: z.array(EducationSchema),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
});

// ─── Responses ─────────────────────────────────────────────────────────────
export const ProfileGetResponseSchema = z.object({ profile: ProfileSchema });
export const WorkRoleMutationResponseSchema = z.object({ workRole: WorkRoleSchema });
export const ProjectMutationResponseSchema = z.object({ project: ProjectSchema });
export const EducationMutationResponseSchema = z.object({ education: EducationSchema });
export const ProfileDeleteResponseSchema = z.object({ success: z.literal(true), id: z.string() });

// ─── Requests ──────────────────────────────────────────────────────────────
export const ProfilePatchSchema = z.object({
    headline: z.string().nullable().optional(),
    summary: z.string().nullable().optional(),
    location: z.string().nullable().optional(),
    email: z.string().nullable().optional(),
    phone: z.string().nullable().optional(),
    links: z.array(ProfileLinkSchema).nullable().optional(),
    skills: z.array(SkillGroupSchema).nullable().optional(),
    hobbies: z.array(z.string()).nullable().optional(),
    languages: z.array(LanguageEntrySchema).nullable().optional(),
}).refine(
    (d) => Object.keys(d).length > 0,
    { message: 'At least one mutable field must be provided' }
);

// M7.8.2 (story S7.13) — scratchpad cap. 8 KB upper bound to keep prompt
// budgets bounded when the LLM grounds on it. Matches the schema-level
// column type (`String?`).
const SCRATCHPAD_MAX_BYTES = 8192;

export const WorkRolePostSchema = z.object({
    company: z.string().min(1),
    title: z.string().min(1),
    location: z.string().nullable().optional(),
    startDate: z.string().datetime(),
    endDate: z.string().datetime().nullable().optional(),
    bullets: z.array(BulletWriteSchema).optional(),
    scratchpad: z.string().max(SCRATCHPAD_MAX_BYTES).nullable().optional(),
    position: z.number().int().optional(),
});

export const WorkRolePatchSchema = z.object({
    id: z.string().min(1),
    company: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
    location: z.string().nullable().optional(),
    startDate: z.string().datetime().optional(),
    endDate: z.string().datetime().nullable().optional(),
    bullets: z.array(BulletWriteSchema).optional(),
    scratchpad: z.string().max(SCRATCHPAD_MAX_BYTES).nullable().optional(),
    position: z.number().int().optional(),
});

export const ProjectPostSchema = z.object({
    name: z.string().min(1),
    description: z.string().nullable().optional(),
    repoUrl: z.string().nullable().optional(),
    liveUrl: z.string().nullable().optional(),
    bullets: z.array(BulletWriteSchema).optional(),
    githubRepo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).nullable().optional(),
    portfolio: z.boolean().optional(),
    scratchpad: z.string().max(SCRATCHPAD_MAX_BYTES).nullable().optional(),
    position: z.number().int().optional(),
});

export const ProjectPatchSchema = z.object({
    id: z.string().min(1),
    name: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    repoUrl: z.string().nullable().optional(),
    liveUrl: z.string().nullable().optional(),
    bullets: z.array(BulletWriteSchema).optional(),
    githubRepo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).nullable().optional(),
    portfolio: z.boolean().optional(),
    scratchpad: z.string().max(SCRATCHPAD_MAX_BYTES).nullable().optional(),
    position: z.number().int().optional(),
});

export const EducationPostSchema = z.object({
    institution: z.string().min(1),
    degree: z.string().nullable().optional(),
    field: z.string().nullable().optional(),
    startDate: z.string().datetime().nullable().optional(),
    endDate: z.string().datetime().nullable().optional(),
    bullets: z.array(BulletWriteSchema).optional(),
    scratchpad: z.string().max(SCRATCHPAD_MAX_BYTES).nullable().optional(),
    position: z.number().int().optional(),
});

export const EducationPatchSchema = z.object({
    id: z.string().min(1),
    institution: z.string().min(1).optional(),
    degree: z.string().nullable().optional(),
    field: z.string().nullable().optional(),
    startDate: z.string().datetime().nullable().optional(),
    endDate: z.string().datetime().nullable().optional(),
    bullets: z.array(BulletWriteSchema).optional(),
    scratchpad: z.string().max(SCRATCHPAD_MAX_BYTES).nullable().optional(),
    position: z.number().int().optional(),
});

export const ProfileChildDeleteSchema = z.object({ id: z.string().min(1) });

// Wire-format types (dates as ISO strings) — what the API returns over JSON
// and what UI components actually receive. Distinct from the Prisma-backed
// HydratedX types in lib/repositories/profile, which use Date objects.
export type ProfileWire = z.infer<typeof ProfileSchema>;
export type WorkRoleWire = z.infer<typeof WorkRoleSchema>;
export type ProjectWire = z.infer<typeof ProjectSchema>;
export type EducationWire = z.infer<typeof EducationSchema>;

// ─── Profile snapshots (story S7.6) ──────────────────────────────────────────
// List entries are intentionally lightweight — no payload, so the UI list
// renders fast even with hundreds of snapshots. Full payload is fetched via
// the [id] route only when the user opens a specific snapshot.
export const ProfileSnapshotSummarySchema = z.object({
    id: z.string(),
    takenAt: z.string().datetime(),
    label: z.string().nullable(),
});
export const ProfileSnapshotSchema = ProfileSnapshotSummarySchema.extend({
    payload: ProfileSchema,
});

export const ProfileSnapshotPostSchema = z.object({
    label: z.string().max(120).nullable().optional(),
});

export const ProfileSnapshotsListResponseSchema = z.object({
    snapshots: z.array(ProfileSnapshotSummarySchema),
});
export const ProfileSnapshotMutationResponseSchema = z.object({
    snapshot: ProfileSnapshotSummarySchema,
});
export const ProfileSnapshotGetResponseSchema = z.object({
    snapshot: ProfileSnapshotSchema,
});

export type ProfileSnapshotSummaryWire = z.infer<typeof ProfileSnapshotSummarySchema>;
export type ProfileSnapshotWire = z.infer<typeof ProfileSnapshotSchema>;

// ─── Bullet-assist (M7.6.7 — story S7.7 fill + S7.8 rewrite) ────────────────
// Discriminated by `mode`. `bulletId` required for rewrite + tags modes; using
// a literal-tagged discriminator means the type narrows automatically on the
// route side and the UI can't accidentally pass bulletId to fill (or omit it
// from rewrite/tags). `parentKind` enum mirrors lib/profile/bullet-assist.ts:ParentKind.
//
// M7.7.5 added the `'tags'` mode (story S7.10 + S7.11) — per-bullet AI tag
// generator. Same parent + bullet identification as rewrite mode.
export const BulletAssistFillSchema = z.object({
    mode: z.literal('fill'),
    parentKind: z.enum(['work-role', 'project', 'education']),
    parentId: z.string().min(1),
});

export const BulletAssistRewriteSchema = z.object({
    mode: z.literal('rewrite'),
    parentKind: z.enum(['work-role', 'project', 'education']),
    parentId: z.string().min(1),
    bulletId: z.string().min(1),
});

export const BulletAssistTagsSchema = z.object({
    mode: z.literal('tags'),
    parentKind: z.enum(['work-role', 'project', 'education']),
    parentId: z.string().min(1),
    bulletId: z.string().min(1),
});

export const BulletAssistBodySchema = z.discriminatedUnion('mode', [
    BulletAssistFillSchema,
    BulletAssistRewriteSchema,
    BulletAssistTagsSchema,
]);

// Fill returns 1–5 starter bullets; rewrite returns one proposal preserving
// id / tags / locked / excluded. Tags returns the proposed final tag list
// + optional reason string — the client diffs against the bullet's current
// tags and on Accept patches the bullet with `tags = proposal.tags`.
export const BulletAssistFillResponseSchema = z.object({
    mode: z.literal('fill'),
    suggestions: z.array(BulletSchema).min(1).max(5),
});

export const BulletAssistRewriteResponseSchema = z.object({
    mode: z.literal('rewrite'),
    proposal: BulletSchema,
});

export const BulletAssistTagsResponseSchema = z.object({
    mode: z.literal('tags'),
    proposal: z.object({
        tags: z.array(z.string()).min(0).max(7),
        reason: z.string().optional(),
    }),
});

export const BulletAssistResponseSchema = z.discriminatedUnion('mode', [
    BulletAssistFillResponseSchema,
    BulletAssistRewriteResponseSchema,
    BulletAssistTagsResponseSchema,
]);

export type BulletAssistBody = z.infer<typeof BulletAssistBodySchema>;
export type BulletAssistResponse = z.infer<typeof BulletAssistResponseSchema>;
