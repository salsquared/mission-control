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

// Posting-category-conditional pin: an entity is pinned for THIS posting if
// any of its `pinKeywords` matches any of the posting's keywords via whole-
// word case-insensitive lookup. Same matcher the bullet scorer uses, so the
// pin behavior is consistent with how matches are counted elsewhere.
//
// Returns true when at least one pin-keyword × posting-keyword pair matches.
// Empty / null pinKeywords → never pinned. Empty posting keywords → never
// pinned (no posting to match against).
export function entityIsPinned(
    pinKeywords: string[] | null | undefined,
    postingKeywords: readonly string[],
): boolean {
    if (!pinKeywords || pinKeywords.length === 0) return false;
    if (postingKeywords.length === 0) return false;
    const lowerPostingKeywords = postingKeywords.map(normalize);
    for (const pin of pinKeywords) {
        const lowerPin = normalize(pin);
        if (lowerPin.length < 2) continue;
        for (const lowerPosting of lowerPostingKeywords) {
            if (matchesWord(lowerPin, lowerPosting)) return true;
            if (matchesWord(lowerPosting, lowerPin)) return true;
        }
    }
    return false;
}

// `keywordWeights` is a lowercased-keyword → importance multiplier map.
// When a tag or substring match lands on keyword K, the contribution is
// `baseWeight × keywordWeights[lower(K)]` instead of plain `baseWeight`.
// Missing keys default to 1 (preserves legacy behavior for callers that
// don't supply weights). Importance is sourced from `posting-parse`'s
// per-keyword importance field; see `lib/resumes/posting.ts`.
function scoreBullet(
    text: string,
    tags: string[],
    keywords: string[],
    keywordWeights?: Record<string, number>,
): { score: number; matchedTags: string[]; matchedKeywords: string[] } {
    const lowerKeywords = keywords.map(normalize);
    const lowerTags = tags.map(normalize);
    const lowerText = normalize(text);
    const weightOf = (lowerKw: string): number => {
        if (!keywordWeights) return 1;
        const w = keywordWeights[lowerKw];
        return typeof w === "number" && w > 0 ? w : 1;
    };

    // Case-insensitive dedup when counting tag matches: a bullet that
    // somehow ended up with both "software engineering" and "Software
    // Engineering" tagged on it should still only contribute ONE match for
    // the posting keyword "Software Engineering", not two. Without this
    // dedup, legacy double-casing data in the DB (see auto-tag.ts merge
    // bug pre-fix) doubles the score. Keeps the first tag's casing for
    // display in matchedTags.
    const matchedTags: string[] = [];
    const matchedTagLowerSeen = new Set<string>();
    let tagContribution = 0;
    for (const tag of tags) {
        const lowerTag = normalize(tag);
        if (matchedTagLowerSeen.has(lowerTag)) continue;
        if (lowerKeywords.includes(lowerTag)) {
            matchedTagLowerSeen.add(lowerTag);
            matchedTags.push(tag);
            tagContribution += TAG_WEIGHT * weightOf(lowerTag);
        }
    }

    const matchedKeywords: string[] = [];
    let keywordContribution = 0;
    for (let i = 0; i < keywords.length; i++) {
        const kw = lowerKeywords[i];
        if (kw.length < 2) continue;
        if (matchesWord(kw, lowerText)) {
            matchedKeywords.push(keywords[i]);
            keywordContribution += SUBSTRING_WEIGHT * weightOf(kw);
        } else if (lowerTags.includes(kw) && !matchedKeywords.includes(keywords[i])) {
            // already counted via matchedTags — don't double-count
        }
    }

    const score = tagContribution + keywordContribution;
    return { score, matchedTags, matchedKeywords };
}

function selectFor<E extends { id: string; bullets: { id: string; text: string; tags: string[]; locked: boolean; excluded: boolean }[]; pinKeywords?: string[] | null }>(
    entities: E[],
    kind: SelectionKind,
    labelOf: (e: E) => string,
    keywords: string[],
    maxBullets: number,
    keepAlways: (e: E, index: number) => boolean,
    dropZeroScoreEntities: boolean,
    keywordWeights?: Record<string, number>,
): EntitySelection<E>[] {
    const out: EntitySelection<E>[] = [];
    entities.forEach((entity, index) => {
        const candidates: BulletSelection[] = [];
        for (const b of entity.bullets) {
            if (b.excluded) continue;
            const { score, matchedTags, matchedKeywords } = scoreBullet(b.text, b.tags, keywords, keywordWeights);
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
    keywordWeights?: Record<string, number>,
): number {
    if (workRoles.length === 0) return -1;
    const topScoreOf = (idx: number): number => {
        let top = 0;
        for (const b of workRoles[idx].bullets) {
            if (b.excluded) continue;
            if (b.locked) return Number.POSITIVE_INFINITY;
            const s = scoreBullet(b.text, b.tags, keywords, keywordWeights).score;
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
    keywordWeights?: Record<string, number>,
): ResumeSelection {
    const opts = { ...DEFAULTS, ...options };

    const workRoles = sortByStartDateDesc(profile.workRoles);
    const projects = [...profile.projects].sort((a, b) => a.position - b.position);
    const education = sortByStartDateDesc(profile.education);
    const workRoleSpineIdx = pickWorkRoleSpineIndex(workRoles, keywords, keywordWeights);

    // Posting-category-conditional pin. When an entity's `pinKeywords`
    // matches any posting keyword, treat it as keep-always (bypasses the
    // MIN_KEEP_SCORE drop) AND move it to position 0 of its section after
    // selection (overriding score-based / LLM-suggested order). See
    // `entityIsPinned`.
    const isPinned = <E extends { pinKeywords?: string[] | null }>(e: E) =>
        entityIsPinned(e.pinKeywords, keywords);

    // Per section, partition selection so pinned entities come first
    // (in their original sub-order), unpinned follow. Stable. Empty pin
    // partition is a no-op — no wasted work for users who haven't set any
    // pinKeywords.
    const movePinnedToFront = <E extends { entity: { pinKeywords?: string[] | null } }>(
        groups: E[],
    ): E[] => {
        const pinned: E[] = [];
        const rest: E[] = [];
        for (const g of groups) {
            if (isPinned(g.entity)) pinned.push(g);
            else rest.push(g);
        }
        return pinned.length === 0 ? groups : [...pinned, ...rest];
    };

    return {
        workRoles: movePinnedToFront(selectFor(
            workRoles,
            "workRole",
            (e) => `${e.title} @ ${e.company}`,
            keywords,
            opts.maxBulletsPerWorkRole,
            (e, i) => i === workRoleSpineIdx || isPinned(e),
            opts.dropZeroScoreEntities,
            keywordWeights,
        )),
        projects: movePinnedToFront(selectFor(
            projects,
            "project",
            (e) => e.name,
            keywords,
            opts.maxBulletsPerProject,
            (e) => isPinned(e),
            opts.dropZeroScoreEntities,
            keywordWeights,
        )),
        education: movePinnedToFront(selectFor(
            education,
            "education",
            (e) => `${e.degree ?? ""} ${e.institution}`.trim(),
            keywords,
            opts.maxBulletsPerEducation,
            () => true,
            opts.dropZeroScoreEntities,
            keywordWeights,
        )),
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
    // 2026-05-27: filter SKILLS by posting keywords (skills lists can be
    // long-and-bloaty, and tailoring to the posting keeps the resume tight),
    // but show LANGUAGES + HOBBIES unfiltered. Languages (especially "Spanish:
    // Fluent") read as a credential/personality signal that's relevant
    // regardless of role keywords — same way you'd list a license. Hobbies are
    // a personality signal too. Filtering both was the M8.7 default but in
    // practice it drops the entire section for any off-domain posting (a
    // security-guard posting has no keyword overlap with "Spanish" or
    // "Creative Film Writing"), which isn't what users want.
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

    const languages: ExtrasSelection["languages"] = (profile.languages ?? []).map(l => ({
        name: l.name,
        proficiency: l.proficiency,
    }));

    const hobbies = profile.hobbies ?? [];

    return { skills, languages, hobbies };
}

export function flattenSelections(sel: ResumeSelection): BulletSelection[] {
    return [
        ...sel.workRoles.flatMap(e => e.bullets),
        ...sel.projects.flatMap(e => e.bullets),
        ...sel.education.flatMap(e => e.bullets),
    ];
}

// The "most-recent" / current education — the one a resume must ALWAYS include
// (a currently-enrolled school must never be pruned in favor of an older,
// higher-scoring degree, nor demoted below it by the LLM's relevance reorder).
// Rank: currently-enrolled (no endDate) first, then latest endDate, then latest
// startDate, then the user's profile order (lowest position). Robust to missing
// dates — falls back to position, so the school the user lists first wins.
// Returns null for an empty list.
export function mostRecentEducationId(
    education: { id: string; startDate?: string | null; endDate?: string | null; position?: number }[],
): string | null {
    if (education.length === 0) return null;
    const ms = (d?: string | null): number => (d ? new Date(d).getTime() : 0);
    const pos = (p?: number): number => (typeof p === "number" ? p : Number.MAX_SAFE_INTEGER);
    let best = education[0];
    for (let i = 1; i < education.length; i++) {
        const e = education[i];
        const eOngoing = e.endDate == null ? 1 : 0;
        const bOngoing = best.endDate == null ? 1 : 0;
        const better =
            eOngoing > bOngoing ||
            (eOngoing === bOngoing && ms(e.endDate) > ms(best.endDate)) ||
            (eOngoing === bOngoing && ms(e.endDate) === ms(best.endDate) && ms(e.startDate) > ms(best.startDate)) ||
            (eOngoing === bOngoing &&
                ms(e.endDate) === ms(best.endDate) &&
                ms(e.startDate) === ms(best.startDate) &&
                pos(e.position) < pos(best.position));
        if (better) best = e;
    }
    return best.id;
}
