import { prisma } from '@/lib/prisma';
import type { Profile, WorkRole, Project, Education } from '@prisma/client';
import { parseBullets, serializeBullets, normalizeBullet } from '@/lib/profile/bullets';
import type { Bullet } from '@/lib/profile/types';

// Hydrated shapes: bullets parsed from JSON string into Bullet[].
export type HydratedWorkRole = Omit<WorkRole, 'bullets'> & { bullets: Bullet[] };
export type HydratedProject = Omit<Project, 'bullets' | 'metrics'> & { bullets: Bullet[]; metrics: unknown | null };
export type HydratedEducation = Omit<Education, 'bullets'> & { bullets: Bullet[] };

export type ProfileLink = { label: string; url: string };
export type HydratedProfile = Omit<Profile, 'links'> & {
    links: ProfileLink[] | null;
    workRoles: HydratedWorkRole[];
    projects: HydratedProject[];
    education: HydratedEducation[];
};

function parseLinks(raw: string | null): ProfileLink[] | null {
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return null;
        return parsed.filter((x) => x && typeof x.label === 'string' && typeof x.url === 'string');
    } catch {
        return null;
    }
}

function hydrateWorkRole(row: WorkRole): HydratedWorkRole {
    return { ...row, bullets: parseBullets(row.bullets) };
}
function hydrateProject(row: Project): HydratedProject {
    let metrics: unknown | null = null;
    if (row.metrics) {
        try { metrics = JSON.parse(row.metrics); } catch { metrics = null; }
    }
    return { ...row, bullets: parseBullets(row.bullets), metrics };
}
function hydrateEducation(row: Education): HydratedEducation {
    return { ...row, bullets: parseBullets(row.bullets) };
}

// Lazily create an empty profile on first read so the UI always has something
// to render. Returns the fully hydrated tree.
export async function findOrCreateProfile(userId: string): Promise<HydratedProfile> {
    const existing = await prisma.profile.findUnique({
        where: { userId },
        include: {
            workRoles: { orderBy: { position: 'asc' } },
            projects: { orderBy: { position: 'asc' } },
            education: { orderBy: { position: 'asc' } },
        },
    });
    const row = existing ?? await prisma.profile.create({
        data: { userId },
        include: {
            workRoles: { orderBy: { position: 'asc' } },
            projects: { orderBy: { position: 'asc' } },
            education: { orderBy: { position: 'asc' } },
        },
    });
    return {
        ...row,
        links: parseLinks(row.links),
        workRoles: row.workRoles.map(hydrateWorkRole),
        projects: row.projects.map(hydrateProject),
        education: row.education.map(hydrateEducation),
    };
}

export interface ProfileHeaderUpdate {
    headline?: string | null;
    summary?: string | null;
    location?: string | null;
    email?: string | null;
    phone?: string | null;
    links?: ProfileLink[] | null;
}

export async function updateProfileHeader(userId: string, data: ProfileHeaderUpdate): Promise<HydratedProfile> {
    const payload: Record<string, unknown> = {};
    if (data.headline !== undefined) payload.headline = data.headline;
    if (data.summary !== undefined) payload.summary = data.summary;
    if (data.location !== undefined) payload.location = data.location;
    if (data.email !== undefined) payload.email = data.email;
    if (data.phone !== undefined) payload.phone = data.phone;
    if (data.links !== undefined) payload.links = data.links === null ? null : JSON.stringify(data.links);

    await prisma.profile.upsert({
        where: { userId },
        create: { userId, ...payload },
        update: payload,
    });
    return findOrCreateProfile(userId);
}

// ─── WorkRole CRUD ─────────────────────────────────────────────────────────
async function profileIdForUser(userId: string): Promise<string> {
    const p = await prisma.profile.upsert({
        where: { userId },
        create: { userId },
        update: {},
        select: { id: true },
    });
    return p.id;
}

async function nextWorkRolePosition(profileId: string): Promise<number> {
    const max = await prisma.workRole.aggregate({ where: { profileId }, _max: { position: true } });
    return (max._max.position ?? 0) + 1;
}
async function nextProjectPosition(profileId: string): Promise<number> {
    const max = await prisma.project.aggregate({ where: { profileId }, _max: { position: true } });
    return (max._max.position ?? 0) + 1;
}
async function nextEducationPosition(profileId: string): Promise<number> {
    const max = await prisma.education.aggregate({ where: { profileId }, _max: { position: true } });
    return (max._max.position ?? 0) + 1;
}

export interface WorkRoleCreateInput {
    company: string;
    title: string;
    location?: string | null;
    startDate: Date;
    endDate?: Date | null;
    bullets?: Array<Partial<Bullet> & { text: string }>;
    position?: number;
}

export async function createWorkRole(userId: string, input: WorkRoleCreateInput): Promise<HydratedWorkRole> {
    const profileId = await profileIdForUser(userId);
    const position = input.position ?? await nextWorkRolePosition(profileId);
    const bullets = (input.bullets ?? []).map(normalizeBullet);
    const row = await prisma.workRole.create({
        data: {
            profileId,
            company: input.company,
            title: input.title,
            location: input.location ?? null,
            startDate: input.startDate,
            endDate: input.endDate ?? null,
            bullets: serializeBullets(bullets),
            position,
        },
    });
    return hydrateWorkRole(row);
}

export interface WorkRoleUpdateInput {
    company?: string;
    title?: string;
    location?: string | null;
    startDate?: Date;
    endDate?: Date | null;
    bullets?: Array<Partial<Bullet> & { text: string }>;
    position?: number;
}

export async function updateWorkRole(userId: string, id: string, input: WorkRoleUpdateInput): Promise<HydratedWorkRole | null> {
    // Ownership check via profile join — single round-trip.
    const existing = await prisma.workRole.findFirst({
        where: { id, profile: { userId } },
        select: { id: true },
    });
    if (!existing) return null;
    const payload: Record<string, unknown> = {};
    if (input.company !== undefined) payload.company = input.company;
    if (input.title !== undefined) payload.title = input.title;
    if (input.location !== undefined) payload.location = input.location;
    if (input.startDate !== undefined) payload.startDate = input.startDate;
    if (input.endDate !== undefined) payload.endDate = input.endDate;
    if (input.position !== undefined) payload.position = input.position;
    if (input.bullets !== undefined) payload.bullets = serializeBullets(input.bullets.map(normalizeBullet));
    const row = await prisma.workRole.update({ where: { id }, data: payload });
    return hydrateWorkRole(row);
}

export async function deleteWorkRole(userId: string, id: string): Promise<boolean> {
    const existing = await prisma.workRole.findFirst({
        where: { id, profile: { userId } },
        select: { id: true },
    });
    if (!existing) return false;
    await prisma.workRole.delete({ where: { id } });
    return true;
}

// ─── Project CRUD ──────────────────────────────────────────────────────────
export interface ProjectCreateInput {
    name: string;
    description?: string | null;
    repoUrl?: string | null;
    liveUrl?: string | null;
    bullets?: Array<Partial<Bullet> & { text: string }>;
    githubRepo?: string | null;
    portfolio?: boolean;
    position?: number;
}

export async function createProject(userId: string, input: ProjectCreateInput): Promise<HydratedProject> {
    const profileId = await profileIdForUser(userId);
    const position = input.position ?? await nextProjectPosition(profileId);
    const bullets = (input.bullets ?? []).map(normalizeBullet);
    const row = await prisma.project.create({
        data: {
            profileId,
            name: input.name,
            description: input.description ?? null,
            repoUrl: input.repoUrl ?? null,
            liveUrl: input.liveUrl ?? null,
            bullets: serializeBullets(bullets),
            githubRepo: input.githubRepo ?? null,
            portfolio: input.portfolio ?? false,
            position,
        },
    });
    return hydrateProject(row);
}

export interface ProjectUpdateInput {
    name?: string;
    description?: string | null;
    repoUrl?: string | null;
    liveUrl?: string | null;
    bullets?: Array<Partial<Bullet> & { text: string }>;
    githubRepo?: string | null;
    portfolio?: boolean;
    position?: number;
}

export async function updateProject(userId: string, id: string, input: ProjectUpdateInput): Promise<HydratedProject | null> {
    const existing = await prisma.project.findFirst({
        where: { id, profile: { userId } },
        select: { id: true },
    });
    if (!existing) return null;
    const payload: Record<string, unknown> = {};
    if (input.name !== undefined) payload.name = input.name;
    if (input.description !== undefined) payload.description = input.description;
    if (input.repoUrl !== undefined) payload.repoUrl = input.repoUrl;
    if (input.liveUrl !== undefined) payload.liveUrl = input.liveUrl;
    if (input.githubRepo !== undefined) payload.githubRepo = input.githubRepo;
    if (input.portfolio !== undefined) payload.portfolio = input.portfolio;
    if (input.position !== undefined) payload.position = input.position;
    if (input.bullets !== undefined) payload.bullets = serializeBullets(input.bullets.map(normalizeBullet));
    const row = await prisma.project.update({ where: { id }, data: payload });
    return hydrateProject(row);
}

export async function deleteProject(userId: string, id: string): Promise<boolean> {
    const existing = await prisma.project.findFirst({
        where: { id, profile: { userId } },
        select: { id: true },
    });
    if (!existing) return false;
    await prisma.project.delete({ where: { id } });
    return true;
}

// ─── Education CRUD ────────────────────────────────────────────────────────
export interface EducationCreateInput {
    institution: string;
    degree?: string | null;
    field?: string | null;
    startDate?: Date | null;
    endDate?: Date | null;
    bullets?: Array<Partial<Bullet> & { text: string }>;
    position?: number;
}

export async function createEducation(userId: string, input: EducationCreateInput): Promise<HydratedEducation> {
    const profileId = await profileIdForUser(userId);
    const position = input.position ?? await nextEducationPosition(profileId);
    const bullets = (input.bullets ?? []).map(normalizeBullet);
    const row = await prisma.education.create({
        data: {
            profileId,
            institution: input.institution,
            degree: input.degree ?? null,
            field: input.field ?? null,
            startDate: input.startDate ?? null,
            endDate: input.endDate ?? null,
            bullets: serializeBullets(bullets),
            position,
        },
    });
    return hydrateEducation(row);
}

export interface EducationUpdateInput {
    institution?: string;
    degree?: string | null;
    field?: string | null;
    startDate?: Date | null;
    endDate?: Date | null;
    bullets?: Array<Partial<Bullet> & { text: string }>;
    position?: number;
}

export async function updateEducation(userId: string, id: string, input: EducationUpdateInput): Promise<HydratedEducation | null> {
    const existing = await prisma.education.findFirst({
        where: { id, profile: { userId } },
        select: { id: true },
    });
    if (!existing) return null;
    const payload: Record<string, unknown> = {};
    if (input.institution !== undefined) payload.institution = input.institution;
    if (input.degree !== undefined) payload.degree = input.degree;
    if (input.field !== undefined) payload.field = input.field;
    if (input.startDate !== undefined) payload.startDate = input.startDate;
    if (input.endDate !== undefined) payload.endDate = input.endDate;
    if (input.position !== undefined) payload.position = input.position;
    if (input.bullets !== undefined) payload.bullets = serializeBullets(input.bullets.map(normalizeBullet));
    const row = await prisma.education.update({ where: { id }, data: payload });
    return hydrateEducation(row);
}

export async function deleteEducation(userId: string, id: string): Promise<boolean> {
    const existing = await prisma.education.findFirst({
        where: { id, profile: { userId } },
        select: { id: true },
    });
    if (!existing) return false;
    await prisma.education.delete({ where: { id } });
    return true;
}
