import type { ProfileWire, WorkRoleWire, ProjectWire, EducationWire } from "@/lib/schemas/profile";
import type { ResumeSelection, BulletSelection, EntitySelection, SelectionKind } from "@/lib/resumes/select";

// The shape persisted in GeneratedResume.selections (see app/api/resumes/route.ts).
export interface StoredSelectionRow {
    kind: SelectionKind;
    sourceId: string;
    sourceLabel: string;
    bulletId: string;
    originalText: string;
    rewrittenText?: string;
    score?: number;
    matchedTags?: string[];
    matchedKeywords?: string[];
    locked?: boolean;
    synthSource?: "scratchpad";
}

// Per-bullet match override, keyed by bulletId — used to refresh matched
// tags/keywords against a SPECIFIC posting (vs the canon keywords the stored
// rows were scored against), so the rewrite emphasizes the right terms.
export type MatchOverride = Map<string, { matchedTags: string[]; matchedKeywords: string[] }>;

function toBullet(r: StoredSelectionRow, matches: MatchOverride): BulletSelection {
    const m = matches.get(r.bulletId);
    return {
        kind: r.kind,
        sourceId: r.sourceId,
        sourceLabel: r.sourceLabel,
        bulletId: r.bulletId,
        originalText: r.originalText,
        score: typeof r.score === "number" ? r.score : 0,
        matchedTags: m?.matchedTags ?? [],
        matchedKeywords: m?.matchedKeywords ?? [],
        locked: !!r.locked,
        ...(r.synthSource ? { synthSource: r.synthSource } : {}),
    };
}

function groupKind<E extends { id: string }>(
    rows: StoredSelectionRow[],
    kind: SelectionKind,
    entityMap: Map<string, E>,
    matches: MatchOverride,
): EntitySelection<E>[] {
    const order: string[] = [];
    const byId = new Map<string, BulletSelection[]>();
    for (const r of rows) {
        if (r.kind !== kind) continue;
        if (!byId.has(r.sourceId)) { byId.set(r.sourceId, []); order.push(r.sourceId); }
        byId.get(r.sourceId)!.push(toBullet(r, matches));
    }
    const out: EntitySelection<E>[] = [];
    for (const id of order) {
        const entity = entityMap.get(id);
        if (!entity) continue; // entity deleted from the profile since canon gen — drop it
        out.push({ entity, bullets: byId.get(id)! });
    }
    return out;
}

/**
 * Rebuild the nested ResumeSelection from a canon resume's stored FLAT
 * `selections` + the frozen `profileSnapshot`, preserving entity + bullet order
 * (so the specialized resume keeps the canon's exact curated layout — §6 Q5).
 *
 * `matches` optionally refreshes per-bullet matched tags/keywords against a
 * specific posting; bullets not present default to no-match (rewriteBullets
 * then passes them through verbatim). Entities that no longer exist in the
 * snapshot are dropped.
 */
export function reconstructSelection(
    stored: StoredSelectionRow[],
    profile: ProfileWire,
    matches: MatchOverride = new Map(),
): ResumeSelection {
    return {
        workRoles: groupKind<WorkRoleWire>(stored, "workRole", new Map(profile.workRoles.map((e) => [e.id, e])), matches),
        projects: groupKind<ProjectWire>(stored, "project", new Map(profile.projects.map((e) => [e.id, e])), matches),
        education: groupKind<EducationWire>(stored, "education", new Map(profile.education.map((e) => [e.id, e])), matches),
    };
}
