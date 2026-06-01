import type { ProfileWire, WorkRoleWire, ProjectWire, EducationWire } from "@/lib/schemas/profile";
import type { CanonSelection } from "@/lib/schemas/canons";
import type { ResumeSelection, BulletSelection, EntitySelection, SelectionKind } from "@/lib/resumes/select";

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
    b: { id: string; text: string },
): BulletSelection {
    return {
        kind,
        sourceId,
        sourceLabel,
        bulletId: b.id,
        originalText: b.text,
        score: 0,
        matchedTags: [],
        matchedKeywords: [],
        locked: false,
    };
}

function resolveKind<E extends { id: string; bullets: { id: string; text: string }[] }>(
    entities: E[],
    kind: SelectionKind,
    labelOf: (e: E) => string,
    selection: CanonSelection,
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
            .map((b) => manualBullet(kind, entity.id, label, b));
        out.push({ entity, bullets });
    }
    return out;
}

export function resolveSelection(profile: ProfileWire, selection: CanonSelection): ResumeSelection {
    return {
        workRoles: resolveKind<WorkRoleWire>(
            profile.workRoles,
            "workRole",
            (e) => `${e.title} @ ${e.company}`,
            selection,
        ),
        projects: resolveKind<ProjectWire>(
            profile.projects,
            "project",
            (e) => e.name,
            selection,
        ),
        education: resolveKind<EducationWire>(
            profile.education,
            "education",
            (e) => `${e.degree ?? ""} ${e.institution}`.trim(),
            selection,
        ),
    };
}
