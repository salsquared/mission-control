// Story S10.2 — diff between two GeneratedResume rows. Pure function; no I/O.
// The route layer parses the rows out of the DB (postingInput / selections /
// skillsGap are stored as JSON strings) and hands the parsed shape in here.

export interface StoredSelection {
    kind: "workRole" | "project" | "education";
    sourceId: string;
    sourceLabel: string;
    bulletId: string;
    originalText: string;
    rewrittenText: string;
    score: number;
    matchedTags: string[];
    matchedKeywords: string[];
    locked: boolean;
}

export interface ResumeForDiff {
    id: string;
    createdAt: string;
    applicationId: string | null;
    company: string | null;       // pulled from postingInput
    title: string | null;         // pulled from postingInput
    parsedKeywords: string[];
    skillsGap: string[];
    selections: StoredSelection[];
}

export interface SharedSelection {
    bulletId: string;
    a: StoredSelection;
    b: StoredSelection;
    rewriteChanged: boolean;
    originalChanged: boolean;
    scoreDelta: number;     // b.score - a.score
    keywordsOnlyA: string[];
    keywordsOnlyB: string[];
    tagsOnlyA: string[];
    tagsOnlyB: string[];
}

export interface ResumeDiff {
    a: Pick<ResumeForDiff, "id" | "createdAt" | "applicationId" | "company" | "title">;
    b: Pick<ResumeForDiff, "id" | "createdAt" | "applicationId" | "company" | "title">;
    keywords: { onlyA: string[]; onlyB: string[]; both: string[] };
    skillsGap: { onlyA: string[]; onlyB: string[]; both: string[] };
    selections: {
        onlyA: StoredSelection[];
        onlyB: StoredSelection[];
        shared: SharedSelection[];
    };
    summary: {
        keywordsChanged: number;       // |onlyA| + |onlyB|
        selectionsChanged: number;     // |selections.onlyA| + |selections.onlyB|
        rewritesChanged: number;       // shared bullets whose rewrittenText differs
    };
}

// Set helpers — preserve insertion order from `aList` (the "left" side) so
// callers can render keywords / selections in their original posting order.
function setDiffOrdered<T>(aList: T[], bList: T[]): { onlyA: T[]; onlyB: T[]; both: T[] } {
    const aSet = new Set(aList);
    const bSet = new Set(bList);
    const onlyA: T[] = [];
    const both: T[] = [];
    for (const x of aList) {
        if (bSet.has(x)) both.push(x);
        else onlyA.push(x);
    }
    const onlyB = bList.filter(x => !aSet.has(x));
    return { onlyA, onlyB, both };
}

function indexByBulletId(sels: StoredSelection[]): Map<string, StoredSelection> {
    const out = new Map<string, StoredSelection>();
    for (const s of sels) out.set(s.bulletId, s);
    return out;
}

export function computeResumeDiff(a: ResumeForDiff, b: ResumeForDiff): ResumeDiff {
    const keywords = setDiffOrdered(a.parsedKeywords, b.parsedKeywords);
    const skillsGap = setDiffOrdered(a.skillsGap, b.skillsGap);

    const aByBullet = indexByBulletId(a.selections);
    const bByBullet = indexByBulletId(b.selections);

    const onlyA: StoredSelection[] = [];
    const shared: SharedSelection[] = [];
    for (const s of a.selections) {
        const counterpart = bByBullet.get(s.bulletId);
        if (!counterpart) {
            onlyA.push(s);
            continue;
        }
        const rewriteChanged = s.rewrittenText !== counterpart.rewrittenText;
        const originalChanged = s.originalText !== counterpart.originalText;
        const keywordsOnlyA = s.matchedKeywords.filter(k => !counterpart.matchedKeywords.includes(k));
        const keywordsOnlyB = counterpart.matchedKeywords.filter(k => !s.matchedKeywords.includes(k));
        const tagsOnlyA = s.matchedTags.filter(t => !counterpart.matchedTags.includes(t));
        const tagsOnlyB = counterpart.matchedTags.filter(t => !s.matchedTags.includes(t));
        shared.push({
            bulletId: s.bulletId,
            a: s,
            b: counterpart,
            rewriteChanged,
            originalChanged,
            scoreDelta: counterpart.score - s.score,
            keywordsOnlyA,
            keywordsOnlyB,
            tagsOnlyA,
            tagsOnlyB,
        });
    }
    const onlyB: StoredSelection[] = [];
    for (const s of b.selections) {
        if (!aByBullet.has(s.bulletId)) onlyB.push(s);
    }

    const rewritesChanged = shared.filter(s => s.rewriteChanged).length;

    return {
        a: { id: a.id, createdAt: a.createdAt, applicationId: a.applicationId, company: a.company, title: a.title },
        b: { id: b.id, createdAt: b.createdAt, applicationId: b.applicationId, company: b.company, title: b.title },
        keywords,
        skillsGap,
        selections: { onlyA, onlyB, shared },
        summary: {
            keywordsChanged: keywords.onlyA.length + keywords.onlyB.length,
            selectionsChanged: onlyA.length + onlyB.length,
            rewritesChanged,
        },
    };
}
