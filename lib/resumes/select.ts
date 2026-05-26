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
    /**
     * M8.6 (story S7.13 resume-gen half) — when set to "scratchpad", this
     * bullet was synthesized at resume-gen time from the parent entity's
     * scratchpad text (NOT a real bullet in the user's profile). Used by
     * the trace UI to render a distinct chip + by skills-gap to count
     * synthesized coverage as gap-closing.
     */
    synthSource?: "scratchpad";
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
     * If true, an entity whose top-scoring bullet falls below `MIN_KEEP_SCORE`
     * (currently `TAG_WEIGHT`, i.e. 2) is dropped entirely. This means a
     * single coincidental substring match — e.g. the literal word "security"
     * appearing inside a Postgres-migration bullet on a security-officer
     * posting — is NOT enough to keep an off-topic entity; the entity needs
     * either a real tag match (worth 2) or multiple keyword matches.
     *
     * Exception: a work-role "spine" entry is always kept (so the resume has
     * at least one work role) — see `pickWorkRoleSpineIndex` for which role
     * gets that protection. All education entries are always kept regardless
     * of score.
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
// Drop threshold for `dropZeroScoreEntities`. An entity whose top bullet
// scores below this is dropped (unless `keepAlways` says otherwise). Set to
// TAG_WEIGHT so a single tag hit keeps the entity, but a single coincidental
// substring match does not — see the doc on `dropZeroScoreEntities`.
const MIN_KEEP_SCORE = TAG_WEIGHT;

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
        if (dropZeroScoreEntities && topScore < MIN_KEEP_SCORE && !keepAlways(entity, index)) return;
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

/**
 * Pick which work role gets the always-keep "spine" slot.
 *
 * Default: the most-recent role (index 0 after sortByStartDateDesc) — the
 * resume should reflect what the candidate is doing now.
 *
 * Override: if the most-recent role's top bullet scores BELOW
 * `MIN_KEEP_SCORE` for this posting (i.e. it's off-topic — e.g. a current
 * security-officer role on a software-engineering posting), fall back to
 * whichever role scores highest. This prevents an off-topic current job
 * from occupying the "spine" slot on resumes where it doesn't earn its keep.
 *
 * Final fallback: if EVERY role is below MIN_KEEP_SCORE, return index 0
 * anyway — the work-role section should never be empty when the user has
 * work roles in their profile.
 *
 * `workRoles` must already be sorted by startDate desc.
 */
function pickWorkRoleSpineIndex(
    workRoles: { bullets: { text: string; tags: string[]; locked: boolean; excluded: boolean }[] }[],
    keywords: string[],
): number {
    if (workRoles.length === 0) return -1;
    const topScoreOf = (idx: number): number => {
        let top = 0;
        for (const b of workRoles[idx].bullets) {
            if (b.excluded) continue;
            if (b.locked) return Number.POSITIVE_INFINITY;
            const s = scoreBullet(b.text, b.tags, keywords).score;
            if (s > top) top = s;
        }
        return top;
    };
    const mostRecentScore = topScoreOf(0);
    if (mostRecentScore >= MIN_KEEP_SCORE) return 0;
    let bestIdx = 0;
    let bestScore = mostRecentScore;
    for (let i = 1; i < workRoles.length; i++) {
        const s = topScoreOf(i);
        if (s > bestScore) { bestScore = s; bestIdx = i; }
    }
    return bestScore >= MIN_KEEP_SCORE ? bestIdx : 0;
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
    const workRoleSpineIdx = pickWorkRoleSpineIndex(workRoles, keywords);

    return {
        workRoles: selectFor(
            workRoles,
            "workRole",
            (e) => `${e.title} @ ${e.company}`,
            keywords,
            opts.maxBulletsPerWorkRole,
            (_e, i) => i === workRoleSpineIdx,
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

// ─── Profile extras: skills / languages / hobbies ──────────────────────────
// Posting-relevance filter for the top-level Profile fields the resume renderer
// surfaces below the bulleted sections. Whole-word matching (same as the bullet
// scorer) so a keyword "Go" doesn't pull in "Golang" by substring.

export interface ExtrasSelection {
    skills: { category: string; items: string[] }[];
    languages: { name: string; proficiency: string }[];
    hobbies: string[];
}

export function selectProfileExtras(
    profile: ProfileWire,
    keywords: string[],
): ExtrasSelection {
    const lowerKeywords = keywords.map(normalize);
    const matchesAnyKeyword = (item: string): boolean => {
        const lowerItem = normalize(item);
        return lowerKeywords.some(kw => matchesWord(kw, lowerItem));
    };

    const skills: ExtrasSelection["skills"] = [];
    for (const group of profile.skills ?? []) {
        const filtered = group.items.filter(matchesAnyKeyword);
        if (filtered.length > 0) {
            skills.push({ category: group.category, items: filtered });
        }
    }

    const languages: ExtrasSelection["languages"] = [];
    for (const lang of profile.languages ?? []) {
        if (matchesAnyKeyword(lang.name)) {
            languages.push({ name: lang.name, proficiency: lang.proficiency });
        }
    }

    const hobbies = (profile.hobbies ?? []).filter(matchesAnyKeyword);

    return { skills, languages, hobbies };
}

export function flattenSelections(sel: ResumeSelection): BulletSelection[] {
    return [
        ...sel.workRoles.flatMap(e => e.bullets),
        ...sel.projects.flatMap(e => e.bullets),
        ...sel.education.flatMap(e => e.bullets),
    ];
}
