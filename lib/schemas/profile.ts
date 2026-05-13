import { z } from 'zod';

// ─── Bullet ────────────────────────────────────────────────────────────────
// Mirrors lib/profile/types.ts:Bullet. When *writing*, id is optional so a
// brand-new bullet can be created without the client minting an id first;
// normalizeBullet() in lib/profile/bullets.ts stamps one server-side.
export const BulletSchema = z.object({
    id: z.string(),
    text: z.string(),
    tags: z.array(z.string()),
    locked: z.boolean(),
    excluded: z.boolean(),
});

export const BulletWriteSchema = z.object({
    id: z.string().optional(),
    text: z.string().min(1),
    tags: z.array(z.string()).optional(),
    locked: z.boolean().optional(),
    excluded: z.boolean().optional(),
});

// Optional link entry (Profile.links is a JSON array of these).
export const ProfileLinkSchema = z.object({
    label: z.string(),
    url: z.string().url(),
});

// ─── Entity shapes (responses include parsed bullets, not the JSON string) ──
export const WorkRoleSchema = z.object({
    id: z.string(),
    profileId: z.string(),
    company: z.string(),
    title: z.string(),
    location: z.string().nullable(),
    startDate: z.string().datetime(),
    endDate: z.string().datetime().nullable(),
    bullets: z.array(BulletSchema),
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
}).refine(
    (d) => Object.keys(d).length > 0,
    { message: 'At least one mutable field must be provided' }
);

export const WorkRolePostSchema = z.object({
    company: z.string().min(1),
    title: z.string().min(1),
    location: z.string().nullable().optional(),
    startDate: z.string().datetime(),
    endDate: z.string().datetime().nullable().optional(),
    bullets: z.array(BulletWriteSchema).optional(),
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
    position: z.number().int().optional(),
});

export const ProjectPostSchema = z.object({
    name: z.string().min(1),
    description: z.string().nullable().optional(),
    repoUrl: z.string().nullable().optional(),
    liveUrl: z.string().nullable().optional(),
    bullets: z.array(BulletWriteSchema).optional(),
    position: z.number().int().optional(),
});

export const ProjectPatchSchema = z.object({
    id: z.string().min(1),
    name: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    repoUrl: z.string().nullable().optional(),
    liveUrl: z.string().nullable().optional(),
    bullets: z.array(BulletWriteSchema).optional(),
    position: z.number().int().optional(),
});

export const EducationPostSchema = z.object({
    institution: z.string().min(1),
    degree: z.string().nullable().optional(),
    field: z.string().nullable().optional(),
    startDate: z.string().datetime().nullable().optional(),
    endDate: z.string().datetime().nullable().optional(),
    bullets: z.array(BulletWriteSchema).optional(),
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
    position: z.number().int().optional(),
});

export const ProfileChildDeleteSchema = z.object({ id: z.string().min(1) });
