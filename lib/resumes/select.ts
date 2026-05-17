import type {
    ProfileWire,
    WorkRoleWire,
    ProjectWire,
    EducationWire,
} from "@/lib/schemas/profile";

export type SelectionKind = "workRole" | "project" | "education";

export interface BulletSelection {
    kind: SelectionKind;
    sourceId: string;
    sourceLabel: string;
    bulletId: string;
    originalText: string;
    score: number;
    matchedTags: string[];
    matchedKeywords: string[];
    locked: boolean;
}

export interface EntitySelection<E> {
    entity: E;
    bullets: BulletSelection[];
}

export interface ResumeSelection {
    workRoles: EntitySelection<WorkRoleWire>[];
    projects: EntitySelection<ProjectWire>[];
    education: EntitySelection<EducationWire>[];
}

export interface SelectOptions {
    maxBulletsPerWorkRole?: number;
    maxBulletsPerProject?: number;
    maxBulletsPerEducation?: number;
    /**
     * If true, an entity whose top-scoring bullet is zero is dropped entirely.
     * Exception: the most-recent work role and all education entries are always
     * kept even with zero matches, so the resume always has at least the spine.
     */
    dropZeroScoreEntities?: boolean;
}

const DEFAULTS: Required<SelectOptions> = {
    maxBulletsPerWorkRole: 4,
    maxBulletsPerProject: 3,
    maxBulletsPerEducation: 2,
    dropZeroScoreEntities: true,
};

const TAG_WEIGHT = 2;
const SUBSTRING_WEIGHT = 1;

function normalize(s: string): string {
    return s.toLowerCase();
}

// Escape regex metacharacters so keywords like "node.js" or "c++" don't blow
// up the RegExp constructor or match "." as wildcard.
function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// PB-4 (was RAH-4): parity with lib/resumes/skills-gap.ts — match a keyword as a whole
// word so "ai" doesn't substring-match inside "available" and "go" doesn't
// match inside "going". Falls back to substring for symbol-edged tokens
// (e.g. "c++") where \b would lie about the boundary.
function matchesWord(keyword: string, haystack: string): boolean {
    const startsAlnum = /\w/.test(keyword.charAt(0));
    const endsAlnum = /\w/.test(keyword.charAt(keyword.length - 1));
    if (startsAlnum && endsAlnum) {
        return new RegExp(`\\b${escapeRegex(keyword)}\\b`, "i").test(haystack);
    }
    return haystack.includes(keyword);
}

function scoreBullet(
    text: string,
    tags: string[],
    keywords: string[],
): { score: number; matchedTags: string[]; matchedKeywords: string[] } {
    const lowerKeywords = keywords.map(normalize);
    const lowerTags = tags.map(normalize);
    const lowerText = normalize(text);

    const matchedTags: string[] = [];
    for (const tag of tags) {
        if (lowerKeywords.includes(normalize(tag))) matchedTags.push(tag);
    }

    const matchedKeywords: string[] = [];
    for (let i = 0; i < keywords.length; i++) {
        const kw = lowerKeywords[i];
        if (kw.length < 2) continue;
        if (matchesWord(kw, lowerText)) matchedKeywords.push(keywords[i]);
        else if (lowerTags.includes(kw) && !matchedKeywords.includes(keywords[i])) {
            // already counted via matchedTags — don't double-count
        }
    }

    const score = TAG_WEIGHT * matchedTags.length + SUBSTRING_WEIGHT * matchedKeywords.length;
    return { score, matchedTags, matchedKeywords };
}

function selectFor<E extends { id: string; bullets: { id: string; text: string; tags: string[]; locked: boolean; excluded: boolean }[] }>(
    entities: E[],
    kind: SelectionKind,
    labelOf: (e: E) => string,
    keywords: string[],
    maxBullets: number,
    keepAlways: (e: E, index: number) => boolean,
    dropZeroScoreEntities: boolean,
): EntitySelection<E>[] {
    const out: EntitySelection<E>[] = [];
    entities.forEach((entity, index) => {
        const candidates: BulletSelection[] = [];
        for (const b of entity.bullets) {
            if (b.excluded) continue;
            const { score, matchedTags, matchedKeywords } = scoreBullet(b.text, b.tags, keywords);
            candidates.push({
                kind,
                sourceId: entity.id,
                sourceLabel: labelOf(entity),
                bulletId: b.id,
                originalText: b.text,
                score: b.locked ? Number.POSITIVE_INFINITY : score,
                matchedTags,
                matchedKeywords,
                locked: b.locked,
            });
        }
        candidates.sort((a, b) => b.score - a.score);
        const top = candidates.slice(0, maxBullets);
        const topScore = top[0]?.score ?? 0;
        if (top.length === 0) {
            if (keepAlways(entity, index)) out.push({ entity, bullets: [] });
            return;
        }
        if (dropZeroScoreEntities && topScore === 0 && !keepAlways(entity, index)) return;
        out.push({ entity, bullets: top });
    });
    return out;
}

function sortByStartDateDesc<E extends { startDate?: string | null }>(arr: E[]): E[] {
    return [...arr].sort((a, b) => {
        const av = a.startDate ? new Date(a.startDate).getTime() : 0;
        const bv = b.startDate ? new Date(b.startDate).getTime() : 0;
        return bv - av;
    });
}

export function selectBullets(
    profile: ProfileWire,
    keywords: string[],
    options: SelectOptions = {},
): ResumeSelection {
    const opts = { ...DEFAULTS, ...options };

    const workRoles = sortByStartDateDesc(profile.workRoles);
    const projects = [...profile.projects].sort((a, b) => a.position - b.position);
    const education = sortByStartDateDesc(profile.education);

    return {
        workRoles: selectFor(
            workRoles,
            "workRole",
            (e) => `${e.title} @ ${e.company}`,
            keywords,
            opts.maxBulletsPerWorkRole,
            (_e, i) => i === 0,
            opts.dropZeroScoreEntities,
        ),
        projects: selectFor(
            projects,
            "project",
            (e) => e.name,
            keywords,
            opts.maxBulletsPerProject,
            () => false,
            opts.dropZeroScoreEntities,
        ),
        education: selectFor(
            education,
            "education",
            (e) => `${e.degree ?? ""} ${e.institution}`.trim(),
            keywords,
            opts.maxBulletsPerEducation,
            () => true,
            opts.dropZeroScoreEntities,
        ),
    };
}

export function flattenSelections(sel: ResumeSelection): BulletSelection[] {
    return [
        ...sel.workRoles.flatMap(e => e.bullets),
        ...sel.projects.flatMap(e => e.bullets),
        ...sel.education.flatMap(e => e.bullets),
    ];
}
