/**
 * Merge one or many extracted resume trees into an existing profile.
 *
 * Story 30a requires *append-to-repository* semantics — never overwrite.
 * Deterministic match keys per entity, exact-text bullet dedup within each
 * matched entity. LLM-based fuzzy bullet dedup is a follow-up (would let us
 * collapse "Built a TS API" vs "Built a TypeScript API" — for MVP we keep
 * both and rely on the user to lock/exclude later).
 */
import { makeBullet } from "@/lib/profile/bullets";
import type { Bullet } from "@/lib/profile/types";
import type {
    ExtractedProfile,
    ExtractedWorkRole,
    ExtractedProject,
    ExtractedEducation,
} from "@/lib/profile/import-llm";

// ─── Existing-profile shape we care about (subset of HydratedProfile) ─────

export interface ExistingWorkRole {
    id: string;
    company: string;
    title: string;
    location: string | null;
    startDate: Date | null;
    endDate: Date | null;
    bullets: Bullet[];
}
export interface ExistingProject {
    id: string;
    name: string;
    description: string | null;
    repoUrl: string | null;
    liveUrl: string | null;
    bullets: Bullet[];
}
export interface ExistingEducation {
    id: string;
    institution: string;
    degree: string | null;
    field: string | null;
    startDate: Date | null;
    endDate: Date | null;
    bullets: Bullet[];
}
export interface ExistingProfileForMerge {
    headline: string | null;
    summary: string | null;
    location: string | null;
    email: string | null;
    phone: string | null;
    links: { label: string; url: string }[] | null;
    workRoles: ExistingWorkRole[];
    projects: ExistingProject[];
    education: ExistingEducation[];
}

// ─── Output shapes ────────────────────────────────────────────────────────

export interface HeaderPatch {
    headline?: string | null;
    summary?: string | null;
    location?: string | null;
    email?: string | null;
    phone?: string | null;
    links?: { label: string; url: string }[];
}

export interface WorkRoleUpdate {
    existingId: string;
    /** Merged bullets — keeps existing ids, appends new bullets with fresh ids. */
    bullets: Bullet[];
    /** True if at least one new bullet was appended. */
    changed: boolean;
}

export interface WorkRoleCreate {
    company: string;
    title: string;
    location: string | null;
    startDate: Date;
    endDate: Date | null;
    bullets: Bullet[];
}

export interface ProjectUpdate { existingId: string; bullets: Bullet[]; changed: boolean }
export interface ProjectCreate {
    name: string;
    description: string | null;
    repoUrl: string | null;
    liveUrl: string | null;
    bullets: Bullet[];
}

export interface EducationUpdate { existingId: string; bullets: Bullet[]; changed: boolean }
export interface EducationCreate {
    institution: string;
    degree: string | null;
    field: string | null;
    startDate: Date | null;
    endDate: Date | null;
    bullets: Bullet[];
}

export interface MergeCounts {
    workRolesAdded: number;
    workRolesMerged: number;
    /** Work roles dropped because the LLM couldn't infer a startDate (Prisma requires non-null). */
    workRolesDroppedNoStartDate: number;
    projectsAdded: number;
    projectsMerged: number;
    educationAdded: number;
    educationMerged: number;
    bulletsAdded: number;
    bulletsDeduped: number;
    headerFieldsFilled: number;
}

export interface MergeResult {
    headerPatch: HeaderPatch | null;
    workRoleUpdates: WorkRoleUpdate[];
    workRolesToCreate: WorkRoleCreate[];
    projectUpdates: ProjectUpdate[];
    projectsToCreate: ProjectCreate[];
    educationUpdates: EducationUpdate[];
    educationToCreate: EducationCreate[];
    counts: MergeCounts;
    perFile: { filename: string; counts: MergeCounts }[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function norm(s: string | null | undefined): string {
    return (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function parseDate(s: string | null): Date | null {
    if (!s) return null;
    const d = new Date(s);
    if (isNaN(d.getTime())) return null;
    return d;
}

function dateRangeOverlaps(aStart: Date | null, aEnd: Date | null, bStart: Date | null, bEnd: Date | null): boolean {
    const aS = aStart?.getTime() ?? -Infinity;
    const aE = aEnd?.getTime() ?? Infinity;
    const bS = bStart?.getTime() ?? -Infinity;
    const bE = bEnd?.getTime() ?? Infinity;
    return aS <= bE && bS <= aE;
}

function widerRange(
    a: { startDate: Date | null; endDate: Date | null },
    b: { startDate: Date | null; endDate: Date | null },
): { startDate: Date | null; endDate: Date | null } {
    const startDate = (() => {
        if (!a.startDate) return b.startDate;
        if (!b.startDate) return a.startDate;
        return a.startDate.getTime() < b.startDate.getTime() ? a.startDate : b.startDate;
    })();
    // "Present" beats any concrete end date.
    const endDate = a.endDate === null || b.endDate === null
        ? null
        : (a.endDate.getTime() > b.endDate.getTime() ? a.endDate : b.endDate);
    return { startDate, endDate };
}

function bulletKey(text: string): string {
    return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function mergeBullets(
    existing: Bullet[],
    incoming: string[],
): { merged: Bullet[]; added: number; deduped: number } {
    const seen = new Map<string, Bullet>();
    for (const b of existing) seen.set(bulletKey(b.text), b);
    const merged: Bullet[] = [...existing];
    let added = 0;
    let deduped = 0;
    for (const text of incoming) {
        if (!text || !text.trim()) continue;
        const key = bulletKey(text);
        if (seen.has(key)) {
            deduped++;
            continue;
        }
        const fresh = makeBullet(text);
        merged.push(fresh);
        seen.set(key, fresh);
        added++;
    }
    return { merged, added, deduped };
}

function bulletsFromStrings(texts: string[]): Bullet[] {
    return texts.filter(t => t && t.trim()).map(t => makeBullet(t));
}

function emptyCounts(): MergeCounts {
    return {
        workRolesAdded: 0,
        workRolesMerged: 0,
        workRolesDroppedNoStartDate: 0,
        projectsAdded: 0,
        projectsMerged: 0,
        educationAdded: 0,
        educationMerged: 0,
        bulletsAdded: 0,
        bulletsDeduped: 0,
        headerFieldsFilled: 0,
    };
}

function addCounts(a: MergeCounts, b: MergeCounts): MergeCounts {
    return {
        workRolesAdded: a.workRolesAdded + b.workRolesAdded,
        workRolesMerged: a.workRolesMerged + b.workRolesMerged,
        workRolesDroppedNoStartDate: a.workRolesDroppedNoStartDate + b.workRolesDroppedNoStartDate,
        projectsAdded: a.projectsAdded + b.projectsAdded,
        projectsMerged: a.projectsMerged + b.projectsMerged,
        educationAdded: a.educationAdded + b.educationAdded,
        educationMerged: a.educationMerged + b.educationMerged,
        bulletsAdded: a.bulletsAdded + b.bulletsAdded,
        bulletsDeduped: a.bulletsDeduped + b.bulletsDeduped,
        headerFieldsFilled: a.headerFieldsFilled + b.headerFieldsFilled,
    };
}

// ─── Match-key lookups ────────────────────────────────────────────────────

function findWorkRoleMatch(
    candidate: ExtractedWorkRole,
    roles: ExistingWorkRole[],
    pendingCreates: WorkRoleCreate[],
): ExistingWorkRole | WorkRoleCreate | null {
    const cCompany = norm(candidate.company);
    const cTitle = norm(candidate.title);
    const cStart = parseDate(candidate.startDate);
    const cEnd = parseDate(candidate.endDate);

    // First, check pending creates from earlier files in the same import — so a
    // resume uploaded twice in one shot doesn't create two duplicate roles.
    for (const p of pendingCreates) {
        if (norm(p.company) === cCompany && norm(p.title) === cTitle) {
            if (dateRangeOverlaps(cStart, cEnd, p.startDate, p.endDate)) return p;
        }
    }
    // Then existing rows.
    for (const r of roles) {
        if (norm(r.company) === cCompany && norm(r.title) === cTitle) {
            if (dateRangeOverlaps(cStart, cEnd, r.startDate, r.endDate)) return r;
        }
    }
    return null;
}

function findProjectMatch(
    candidate: ExtractedProject,
    projects: ExistingProject[],
    pendingCreates: ProjectCreate[],
): ExistingProject | ProjectCreate | null {
    const cName = norm(candidate.name);
    const cRepo = norm(candidate.repoUrl);
    for (const p of pendingCreates) {
        if (norm(p.name) === cName) {
            if (!cRepo || !norm(p.repoUrl) || norm(p.repoUrl) === cRepo) return p;
        }
    }
    for (const p of projects) {
        if (norm(p.name) === cName) {
            if (!cRepo || !norm(p.repoUrl) || norm(p.repoUrl) === cRepo) return p;
        }
    }
    return null;
}

function findEducationMatch(
    candidate: ExtractedEducation,
    education: ExistingEducation[],
    pendingCreates: EducationCreate[],
): ExistingEducation | EducationCreate | null {
    const cInst = norm(candidate.institution);
    const cDeg = norm(candidate.degree);
    const cField = norm(candidate.field);
    for (const p of pendingCreates) {
        if (norm(p.institution) === cInst && norm(p.degree) === cDeg && norm(p.field) === cField) return p;
    }
    for (const e of education) {
        if (norm(e.institution) === cInst && norm(e.degree) === cDeg && norm(e.field) === cField) return e;
    }
    return null;
}

// ─── Per-file merge into accumulator ──────────────────────────────────────

interface Accumulator {
    headerPatch: HeaderPatch;
    workRoleUpdates: Map<string, WorkRoleUpdate>;
    workRolesToCreate: WorkRoleCreate[];
    projectUpdates: Map<string, ProjectUpdate>;
    projectsToCreate: ProjectCreate[];
    educationUpdates: Map<string, EducationUpdate>;
    educationToCreate: EducationCreate[];
}

function mergeHeader(acc: Accumulator, existing: ExistingProfileForMerge, incoming: ExtractedProfile["header"]): MergeCounts {
    const counts = emptyCounts();
    type StringField = "headline" | "summary" | "location" | "email" | "phone";
    const fields: StringField[] = ["headline", "summary", "location", "email", "phone"];
    for (const f of fields) {
        const existingVal = existing[f];
        const accVal = acc.headerPatch[f];
        const incomingVal = incoming[f];
        if (!existingVal && !accVal && incomingVal && incomingVal.trim().length > 0) {
            acc.headerPatch[f] = incomingVal;
            counts.headerFieldsFilled++;
        }
    }
    if (incoming.links && incoming.links.length > 0) {
        const have = new Map<string, { label: string; url: string }>();
        for (const l of existing.links ?? []) have.set(norm(l.url), l);
        for (const l of acc.headerPatch.links ?? []) have.set(norm(l.url), l);
        let added = 0;
        for (const l of incoming.links) {
            const key = norm(l.url);
            if (!key || have.has(key)) continue;
            have.set(key, l);
            added++;
        }
        if (added > 0) {
            acc.headerPatch.links = [...have.values()];
            counts.headerFieldsFilled += added;
        }
    }
    return counts;
}

function applyMergedToUpdate(
    map: Map<string, WorkRoleUpdate | ProjectUpdate | EducationUpdate>,
    existingId: string,
    bullets: Bullet[],
    changed: boolean,
) {
    const existing = map.get(existingId);
    if (existing) {
        existing.bullets = bullets;
        existing.changed = existing.changed || changed;
    } else {
        map.set(existingId, { existingId, bullets, changed });
    }
}

function mergeOneFile(acc: Accumulator, existing: ExistingProfileForMerge, incoming: ExtractedProfile): MergeCounts {
    const counts = emptyCounts();
    const headerCounts = mergeHeader(acc, existing, incoming.header);
    counts.headerFieldsFilled = headerCounts.headerFieldsFilled;

    // Work roles
    for (const wr of incoming.workRoles) {
        const match = findWorkRoleMatch(wr, existing.workRoles, acc.workRolesToCreate);
        if (match && "id" in match) {
            const update = acc.workRoleUpdates.get(match.id);
            const baseBullets = update?.bullets ?? match.bullets;
            const merged = mergeBullets(baseBullets, wr.bullets);
            applyMergedToUpdate(acc.workRoleUpdates as Map<string, WorkRoleUpdate>, match.id, merged.merged, merged.added > 0);
            counts.workRolesMerged++;
            counts.bulletsAdded += merged.added;
            counts.bulletsDeduped += merged.deduped;
        } else if (match) {
            const merged = mergeBullets(match.bullets, wr.bullets);
            match.bullets = merged.merged;
            const wider = widerRange(
                { startDate: match.startDate, endDate: match.endDate },
                { startDate: parseDate(wr.startDate) ?? match.startDate, endDate: parseDate(wr.endDate) ?? null },
            );
            match.startDate = wider.startDate ?? match.startDate;
            match.endDate = wider.endDate;
            if (!match.location && wr.location) match.location = wr.location;
            counts.workRolesMerged++;
            counts.bulletsAdded += merged.added;
            counts.bulletsDeduped += merged.deduped;
        } else {
            const sd = parseDate(wr.startDate);
            if (!sd) {
                // Prisma's WorkRole.startDate is non-null; we can't create the row.
                // Surface this so the user knows to add the role manually instead
                // of wondering why their resume is half-imported.
                counts.workRolesDroppedNoStartDate++;
                continue;
            }
            acc.workRolesToCreate.push({
                company: wr.company,
                title: wr.title,
                location: wr.location,
                startDate: sd,
                endDate: parseDate(wr.endDate),
                bullets: bulletsFromStrings(wr.bullets),
            });
            counts.workRolesAdded++;
            counts.bulletsAdded += wr.bullets.filter(t => t && t.trim()).length;
        }
    }

    // Projects
    for (const pr of incoming.projects) {
        const match = findProjectMatch(pr, existing.projects, acc.projectsToCreate);
        if (match && "id" in match) {
            const update = acc.projectUpdates.get(match.id);
            const baseBullets = update?.bullets ?? match.bullets;
            const merged = mergeBullets(baseBullets, pr.bullets);
            applyMergedToUpdate(acc.projectUpdates as Map<string, ProjectUpdate>, match.id, merged.merged, merged.added > 0);
            counts.projectsMerged++;
            counts.bulletsAdded += merged.added;
            counts.bulletsDeduped += merged.deduped;
        } else if (match) {
            const merged = mergeBullets(match.bullets, pr.bullets);
            match.bullets = merged.merged;
            if (!match.description && pr.description) match.description = pr.description;
            if (!match.repoUrl && pr.repoUrl) match.repoUrl = pr.repoUrl;
            if (!match.liveUrl && pr.liveUrl) match.liveUrl = pr.liveUrl;
            counts.projectsMerged++;
            counts.bulletsAdded += merged.added;
            counts.bulletsDeduped += merged.deduped;
        } else {
            acc.projectsToCreate.push({
                name: pr.name,
                description: pr.description,
                repoUrl: pr.repoUrl,
                liveUrl: pr.liveUrl,
                bullets: bulletsFromStrings(pr.bullets),
            });
            counts.projectsAdded++;
            counts.bulletsAdded += pr.bullets.filter(t => t && t.trim()).length;
        }
    }

    // Education
    for (const ed of incoming.education) {
        const match = findEducationMatch(ed, existing.education, acc.educationToCreate);
        if (match && "id" in match) {
            const update = acc.educationUpdates.get(match.id);
            const baseBullets = update?.bullets ?? match.bullets;
            const merged = mergeBullets(baseBullets, ed.bullets);
            applyMergedToUpdate(acc.educationUpdates as Map<string, EducationUpdate>, match.id, merged.merged, merged.added > 0);
            counts.educationMerged++;
            counts.bulletsAdded += merged.added;
            counts.bulletsDeduped += merged.deduped;
        } else if (match) {
            const merged = mergeBullets(match.bullets, ed.bullets);
            match.bullets = merged.merged;
            const wider = widerRange(
                { startDate: match.startDate, endDate: match.endDate },
                { startDate: parseDate(ed.startDate), endDate: parseDate(ed.endDate) },
            );
            match.startDate = wider.startDate;
            match.endDate = wider.endDate;
            counts.educationMerged++;
            counts.bulletsAdded += merged.added;
            counts.bulletsDeduped += merged.deduped;
        } else {
            acc.educationToCreate.push({
                institution: ed.institution,
                degree: ed.degree,
                field: ed.field,
                startDate: parseDate(ed.startDate),
                endDate: parseDate(ed.endDate),
                bullets: bulletsFromStrings(ed.bullets),
            });
            counts.educationAdded++;
            counts.bulletsAdded += ed.bullets.filter(t => t && t.trim()).length;
        }
    }

    return counts;
}

export function mergeImports(
    existing: ExistingProfileForMerge,
    files: { filename: string; tree: ExtractedProfile }[],
): MergeResult {
    const acc: Accumulator = {
        headerPatch: {},
        workRoleUpdates: new Map(),
        workRolesToCreate: [],
        projectUpdates: new Map(),
        projectsToCreate: [],
        educationUpdates: new Map(),
        educationToCreate: [],
    };

    const perFile: { filename: string; counts: MergeCounts }[] = [];
    let total = emptyCounts();

    for (const f of files) {
        const c = mergeOneFile(acc, existing, f.tree);
        perFile.push({ filename: f.filename, counts: c });
        total = addCounts(total, c);
    }

    const headerHasChanges = Object.keys(acc.headerPatch).length > 0;
    return {
        headerPatch: headerHasChanges ? acc.headerPatch : null,
        workRoleUpdates: [...acc.workRoleUpdates.values()].filter(u => u.changed),
        workRolesToCreate: acc.workRolesToCreate,
        projectUpdates: [...acc.projectUpdates.values()].filter(u => u.changed),
        projectsToCreate: acc.projectsToCreate,
        educationUpdates: [...acc.educationUpdates.values()].filter(u => u.changed),
        educationToCreate: acc.educationToCreate,
        counts: total,
        perFile,
    };
}
