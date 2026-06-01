import type { ProfileWire, WorkRoleWire, ProjectWire, EducationWire } from "@/lib/schemas/profile";
import type { CanonSelection } from "@/lib/schemas/canons";
import type { ResumeSelection, BulletSelection, EntitySelection, SelectionKind, ExtrasSelection } from "@/lib/resumes/select";
import { scoreBullet } from "@/lib/resumes/select";

// Manual builder selection → renderable ResumeSelection
// (docs/resume-manual-builder.html, P1.3.1).
//
// Turns a saved CanonSelection (binary: entity present in `selection.entities`
// ⇒ included) plus the live profile into the nested ResumeSelection that the
// renderer/specialize/persist machinery already consumes — the same output the
// auto-pipeline's `selectBullets` produces, minus the scoring. Because the
// manual path never scores, the produced BulletSelections carry score 0 / empty
// matches / locked=false (rewrite passes a no-match bullet through verbatim).
//
// Resolution is best-effort against the live profile: an entity or bullet that
// has since been deleted from the profile is silently dropped (mirrors
// `lib/canons/specialize.ts:reconstructSelection`). Entities render in PROFILE
// order, each with only its chosen bullets, in the profile's bullet order (OQ8
// defers user reordering — `bulletIds` is a membership set, not an order, in v1).
// `excluded` is NOT consulted here (inert in v1 — OQ5=B forward-compat); section
// on/off + ordering is applied downstream from `selection.sectionOrder` /
// `sectionsOff`.

function manualBullet(
    kind: SelectionKind,
    sourceId: string,
    sourceLabel: string,
    b: { id: string; text: string; tags?: string[] },
    keywords?: string[],
): BulletSelection {
    // Selection is manual, so `score` stays 0 (it never gates inclusion here).
    // But when the opt-in rewrite is on we DO populate matched tags/keywords
    // against the canon keywords — otherwise rewriteBullets' no-match prefilter
    // would pass every bullet through verbatim and the rewrite would silently
    // no-op. Off (no keywords) → empty matches → verbatim, as intended.
    const m = keywords && keywords.length > 0 ? scoreBullet(b.text, b.tags ?? [], keywords) : null;
    return {
        kind,
        sourceId,
        sourceLabel,
        bulletId: b.id,
        originalText: b.text,
        score: 0,
        matchedTags: m?.matchedTags ?? [],
        matchedKeywords: m?.matchedKeywords ?? [],
        locked: false,
    };
}

function resolveKind<E extends { id: string; bullets: { id: string; text: string; tags?: string[] }[] }>(
    entities: E[],
    kind: SelectionKind,
    labelOf: (e: E) => string,
    selection: CanonSelection,
    keywords?: string[],
): EntitySelection<E>[] {
    const out: EntitySelection<E>[] = [];
    for (const entity of entities) {
        // profile order
        const entry = selection.entities[entity.id];
        if (!entry || entry.kind !== kind) continue; // not included on this resume
        const wanted = new Set(entry.bulletIds);
        const label = labelOf(entity);
        const bullets = entity.bullets
            .filter((b) => wanted.has(b.id)) // chosen bullets, profile bullet order
            .map((b) => manualBullet(kind, entity.id, label, b, keywords));
        out.push({ entity, bullets });
    }
    return out;
}

// `keywords` (optional) enriches matched tags/keywords for the opt-in rewrite —
// see manualBullet. Omit it for a pure verbatim render.
export function resolveSelection(
    profile: ProfileWire,
    selection: CanonSelection,
    keywords?: string[],
): ResumeSelection {
    return {
        workRoles: resolveKind<WorkRoleWire>(
            profile.workRoles,
            "workRole",
            (e) => `${e.title} @ ${e.company}`,
            selection,
            keywords,
        ),
        projects: resolveKind<ProjectWire>(
            profile.projects,
            "project",
            (e) => e.name,
            selection,
            keywords,
        ),
        education: resolveKind<EducationWire>(
            profile.education,
            "education",
            (e) => `${e.degree ?? ""} ${e.institution}`.trim(),
            selection,
            keywords,
        ),
    };
}

// Skills / Languages / Interests for the manual path. Unlike the auto-pipeline's
// posting-keyword filter (`selectProfileExtras`), the user explicitly chose these
// in the builder, so we just intersect their picks with the live profile (drops
// items deleted from the profile since). Skill groups with no surviving picks
// drop entirely. Mirrors the ExtrasSelection shape composeResumeProps consumes.
export function resolveExtras(profile: ProfileWire, selection: CanonSelection): ExtrasSelection {
    const wantSkills = new Set(selection.extras.skillItems);
    const wantLangs = new Set(selection.extras.languages);
    const wantHobbies = new Set(selection.extras.hobbies);
    const skills = (profile.skills ?? [])
        .map((g) => ({ category: g.category, items: g.items.filter((i) => wantSkills.has(i)) }))
        .filter((g) => g.items.length > 0);
    const languages = (profile.languages ?? []).filter((l) => wantLangs.has(l.name));
    const hobbies = (profile.hobbies ?? []).filter((h) => wantHobbies.has(h));
    return { skills, languages, hobbies };
}
