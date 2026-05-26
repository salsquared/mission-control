/**
 * One-page resume pruner.
 *
 * When the user toggles "1 page" on `GenerateResumeCard`, the resume pipeline
 * routes through `renderResumePDFOnePage` instead of a single PDF render:
 *
 *   1. Compose props from the current selection and render a probe PDF.
 *   2. Parse the PDF byte stream to count pages.
 *   3. If pages > 1, drop the lowest-aggregate-score removable entity (or, if
 *      no entities are removable, the lowest-scoring non-locked bullet from an
 *      entity that still has >= 2 bullets) and re-render.
 *   4. Repeat up to `MAX_PRUNE_ITERATIONS`, then return whatever we have.
 *
 * "Unremovable" entities are the first survivors in each section after the
 * selector's sort: `workRoles[0]` (most-recent role / spine after the
 * `pickWorkRoleSpineIndex` guard), `projects[0]` (top user-pinned project),
 * `education[0]` (most-recent degree). An entity that contains a locked
 * bullet is also unremovable — locked bullets must always appear on the
 * resume per the selector's contract.
 *
 * The pruner mutates `selection` in place. Callers that need to surface the
 * post-prune view (e.g. the trace UI + persisted selections row) must
 * re-flatten after the call.
 */

import { renderResumePDF } from "./render-pdf";
import { composeResumeProps } from "./templates/ats-plain";
import type { ResumeSelection, BulletSelection, EntitySelection, ExtrasSelection } from "./select";
import { entityIsPinned } from "./select";
import type { RewrittenBullet } from "./rewrite";
import type { ProfileWire, WorkRoleWire, ProjectWire, EducationWire } from "@/lib/schemas/profile";
import type { SectionKey } from "./tagline-tailor";

const MAX_PRUNE_ITERATIONS = 8;

export interface OnePageResult {
    bytes: Buffer;
    iterations: number;
    finalPages: number;
    prunedEntities: string[];
    prunedBullets: string[];
    hitIterationCap: boolean;
}

/**
 * Compute the set of entity IDs the pruner must preserve regardless of score.
 *  - `selection.{workRoles,projects,education}[0]` — the section "spine"
 *    (most-recent role / top-position project / most-recent degree).
 *  - Any entity whose `pinKeywords` matches a posting keyword
 *    (case-insensitive whole-word). Posting-category-conditional pin —
 *    the user marked this entity "always show on postings with X."
 *
 * `postingKeywords` is optional for back-compat with callers (hermetic
 * smokes, legacy code) that don't have a posting to check against.
 * Without it, only the section-spine rule applies.
 */
export function getUnremovableEntityIds(
    selection: ResumeSelection,
    postingKeywords: readonly string[] = [],
): Set<string> {
    const ids = new Set<string>();
    if (selection.workRoles.length > 0) ids.add(selection.workRoles[0].entity.id);
    if (selection.projects.length > 0) ids.add(selection.projects[0].entity.id);
    if (selection.education.length > 0) ids.add(selection.education[0].entity.id);
    if (postingKeywords.length > 0) {
        for (const g of selection.workRoles) {
            if (entityIsPinned(g.entity.pinKeywords, postingKeywords)) ids.add(g.entity.id);
        }
        for (const g of selection.projects) {
            if (entityIsPinned(g.entity.pinKeywords, postingKeywords)) ids.add(g.entity.id);
        }
        for (const g of selection.education) {
            if (entityIsPinned(g.entity.pinKeywords, postingKeywords)) ids.add(g.entity.id);
        }
    }
    return ids;
}

function aggregateEntityScore(group: EntitySelection<unknown>): number {
    let total = 0;
    for (const b of group.bullets) {
        if (b.locked) return Number.POSITIVE_INFINITY;
        const s = Number.isFinite(b.score) ? b.score : 0;
        total += Math.max(0, s);
    }
    return total;
}

interface SectionHandle {
    key: "workRoles" | "projects" | "education";
    list: EntitySelection<WorkRoleWire>[] | EntitySelection<ProjectWire>[] | EntitySelection<EducationWire>[];
    labelOf: (entity: WorkRoleWire | ProjectWire | EducationWire) => string;
}

function sectionsOf(selection: ResumeSelection): SectionHandle[] {
    return [
        {
            key: "workRoles",
            list: selection.workRoles,
            labelOf: (e) => {
                const wr = e as WorkRoleWire;
                return `${wr.title} @ ${wr.company}`;
            },
        },
        {
            key: "projects",
            list: selection.projects,
            labelOf: (e) => (e as ProjectWire).name,
        },
        {
            key: "education",
            list: selection.education,
            labelOf: (e) => {
                const ed = e as EducationWire;
                return `${ed.degree ?? "Education"} @ ${ed.institution}`;
            },
        },
    ];
}

/**
 * Perform one prune step on `selection`. Returns a descriptor of what was
 * removed, or `null` when nothing more can be pruned (every removable entity
 * is gone and every remaining entity is down to one bullet / locked bullets).
 *
 * Mutates `selection` in place.
 */
export function pruneOneStep(
    selection: ResumeSelection,
    unremovableIds: Set<string>,
): { kind: "entity" | "bullet"; label: string } | null {
    interface EntityCandidate {
        sectionKey: SectionHandle["key"];
        index: number;
        label: string;
        score: number;
    }
    const sections = sectionsOf(selection);

    // Phase 1: drop the lowest-aggregate-score entity that isn't unremovable
    // and whose removal won't empty its section.
    const entityCandidates: EntityCandidate[] = [];
    for (const { key, list, labelOf } of sections) {
        if (list.length <= 1) continue;
        for (let i = 0; i < list.length; i++) {
            const g = list[i];
            if (unremovableIds.has(g.entity.id)) continue;
            const score = aggregateEntityScore(g);
            if (!Number.isFinite(score)) continue;
            entityCandidates.push({
                sectionKey: key,
                index: i,
                label: labelOf(g.entity),
                score,
            });
        }
    }
    if (entityCandidates.length > 0) {
        entityCandidates.sort((a, b) => a.score - b.score);
        const drop = entityCandidates[0];
        // Splice via the correctly-typed list. The cast is safe because each
        // sectionKey maps to its own homogeneous list.
        if (drop.sectionKey === "workRoles") {
            selection.workRoles.splice(drop.index, 1);
        } else if (drop.sectionKey === "projects") {
            selection.projects.splice(drop.index, 1);
        } else {
            selection.education.splice(drop.index, 1);
        }
        return { kind: "entity", label: `${drop.sectionKey}: ${drop.label}` };
    }

    // Phase 2: drop the lowest-scoring non-locked bullet from any entity that
    // has >= 2 bullets. Keeps every entity rendering at least one line.
    interface BulletCandidate {
        bullets: BulletSelection[];
        index: number;
        score: number;
        entityLabel: string;
    }
    let target: BulletCandidate | null = null;
    for (const { list, labelOf } of sections) {
        for (const g of list) {
            if (g.bullets.length <= 1) continue;
            for (let i = 0; i < g.bullets.length; i++) {
                const b = g.bullets[i];
                if (b.locked) continue;
                const s = Number.isFinite(b.score) ? b.score : 0;
                if (target === null || s < target.score) {
                    target = { bullets: g.bullets, index: i, score: s, entityLabel: labelOf(g.entity) };
                }
            }
        }
    }
    if (target !== null) {
        target.bullets.splice(target.index, 1);
        return { kind: "bullet", label: `${target.entityLabel}[bullet${target.index}]` };
    }

    return null;
}

async function countPdfPages(bytes: Buffer): Promise<number> {
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: new Uint8Array(bytes) });
    try {
        const info = await parser.getInfo();
        return info.total ?? 1;
    } finally {
        await parser.destroy().catch(() => undefined);
    }
}

/**
 * Iterative PDF render + prune loop. Returns the final PDF bytes (≤ 1 page if
 * we got there within the iteration cap, else the smallest we could shrink
 * to). `selection` is mutated; the caller should re-flatten if the post-prune
 * view is needed downstream (trace, persistence).
 */
export async function renderResumePDFOnePage(args: {
    profile: ProfileWire;
    selection: ResumeSelection;
    rewrites: RewrittenBullet[];
    tagline: string | null;
    extras: ExtrasSelection;
    sectionOrder: readonly SectionKey[];
    unremovableIds: Set<string>;
}): Promise<OnePageResult> {
    const prunedEntities: string[] = [];
    const prunedBullets: string[] = [];
    let iterations = 0;
    while (true) {
        const props = composeResumeProps(
            args.profile,
            args.selection,
            args.rewrites,
            args.tagline,
            args.extras,
            args.sectionOrder,
        );
        const bytes = await renderResumePDF(props);
        const pages = await countPdfPages(bytes);
        if (pages <= 1) {
            return { bytes, iterations, finalPages: pages, prunedEntities, prunedBullets, hitIterationCap: false };
        }
        if (iterations >= MAX_PRUNE_ITERATIONS) {
            return { bytes, iterations, finalPages: pages, prunedEntities, prunedBullets, hitIterationCap: true };
        }
        const step = pruneOneStep(args.selection, args.unremovableIds);
        if (step === null) {
            return { bytes, iterations, finalPages: pages, prunedEntities, prunedBullets, hitIterationCap: false };
        }
        if (step.kind === "entity") prunedEntities.push(step.label);
        else prunedBullets.push(step.label);
        iterations++;
    }
}
