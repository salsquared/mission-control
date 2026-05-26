/**
 * Deterministic smoke for lib/resumes/one-page.ts pruning logic.
 *
 * Does NOT render PDF — that's the runtime concern, exercised live in dev.
 * What's here: pure-function guarantees on `pruneOneStep` so the iterator
 * loop in the route can trust its invariants.
 *
 *   npx tsx scripts/tests/hermetic/resume-one-page-prune-smoke.ts
 */
import type { ResumeSelection, BulletSelection, EntitySelection } from "@/lib/resumes/select";
import { pruneOneStep, getUnremovableEntityIds } from "@/lib/resumes/one-page";
import type { WorkRoleWire, ProjectWire, EducationWire } from "@/lib/schemas/profile";

let passes = 0;
let fails = 0;
function pass(msg: string) { console.log(`[PASS] ${msg}`); passes++; }
function fail(msg: string, detail?: unknown) { console.error(`[FAIL] ${msg}`, detail ?? ""); fails++; }

const now = new Date().toISOString();

function mkBullet(id: string, score: number, locked = false): BulletSelection {
    return {
        kind: "workRole",
        sourceId: "_",
        sourceLabel: "_",
        bulletId: id,
        originalText: `bullet ${id}`,
        score,
        matchedTags: [],
        matchedKeywords: [],
        locked,
    };
}

function mkWorkRoleSel(id: string, bullets: BulletSelection[], startDate = now): EntitySelection<WorkRoleWire> {
    return {
        entity: {
            id, profileId: "p1", company: `Co-${id}`, title: `Role-${id}`,
            location: null, startDate, endDate: null, bullets: [], position: 0,
            createdAt: now, updatedAt: now, scratchpad: null,
        } as unknown as WorkRoleWire,
        bullets,
    };
}

function mkProjectSel(id: string, bullets: BulletSelection[], position = 0): EntitySelection<ProjectWire> {
    return {
        entity: {
            id, profileId: "p1", name: `Proj-${id}`, description: null,
            repoUrl: null, liveUrl: null, bullets: [], position,
            createdAt: now, updatedAt: now, scratchpad: null,
        } as unknown as ProjectWire,
        bullets,
    };
}

function mkEducationSel(id: string, bullets: BulletSelection[], startDate = now): EntitySelection<EducationWire> {
    return {
        entity: {
            id, profileId: "p1", institution: `Inst-${id}`, degree: "BS", field: "CS",
            startDate, endDate: null, bullets: [], position: 0,
            createdAt: now, updatedAt: now, scratchpad: null,
        } as unknown as EducationWire,
        bullets,
    };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

// 1) Unremovables = workRoles[0] + projects[0] + education[0].
{
    const sel: ResumeSelection = {
        workRoles: [
            mkWorkRoleSel("wr-recent", [mkBullet("b1", 0)]),
            mkWorkRoleSel("wr-old", [mkBullet("b2", 0)]),
        ],
        projects: [
            mkProjectSel("pr-top", [mkBullet("b3", 0)], 0),
            mkProjectSel("pr-second", [mkBullet("b4", 0)], 1),
        ],
        education: [
            mkEducationSel("ed-recent", [mkBullet("b5", 0)]),
            mkEducationSel("ed-old", [mkBullet("b6", 0)]),
        ],
    };
    const ids = getUnremovableEntityIds(sel);
    if (!ids.has("wr-recent")) fail("workRoles[0] not in unremovable set");
    else pass("workRoles[0] (most-recent) marked unremovable");
    if (!ids.has("pr-top")) fail("projects[0] not in unremovable set");
    else pass("projects[0] (top-pinned) marked unremovable");
    if (!ids.has("ed-recent")) fail("education[0] not in unremovable set");
    else pass("education[0] (most-recent) marked unremovable");
    if (ids.has("wr-old") || ids.has("pr-second") || ids.has("ed-old")) {
        fail("non-first entities should NOT be in unremovable set", [...ids]);
    } else {
        pass("non-first entities not marked unremovable");
    }
}

// 2) Pruner drops the lowest-aggregate-score removable entity first.
{
    const sel: ResumeSelection = {
        workRoles: [
            mkWorkRoleSel("wr-recent", [mkBullet("b1", 5)]),         // unremovable
            mkWorkRoleSel("wr-mid", [mkBullet("b2", 4), mkBullet("b3", 4)]), // agg 8
            mkWorkRoleSel("wr-low", [mkBullet("b4", 1)]),            // agg 1 — should drop first
        ],
        projects: [mkProjectSel("pr-top", [mkBullet("b5", 0)])],
        education: [mkEducationSel("ed-recent", [mkBullet("b6", 0)])],
    };
    const ids = getUnremovableEntityIds(sel);
    const step = pruneOneStep(sel, ids);
    if (!step || step.kind !== "entity" || !step.label.includes("workRoles")) {
        fail("expected an entity prune from workRoles", step);
    } else {
        pass(`first prune dropped entity: ${step.label}`);
    }
    if (sel.workRoles.find(g => g.entity.id === "wr-low")) {
        fail("wr-low (lowest aggregate score) should have been removed");
    } else {
        pass("wr-low removed (lowest aggregate score)");
    }
    if (!sel.workRoles.find(g => g.entity.id === "wr-recent")) {
        fail("wr-recent (unremovable) was wrongly dropped");
    } else {
        pass("wr-recent preserved");
    }
}

// 3) When only unremovables remain, pruner drops lowest-scoring bullets next.
{
    const sel: ResumeSelection = {
        workRoles: [mkWorkRoleSel("wr-only", [
            mkBullet("b1", 8),
            mkBullet("b2", 1), // lowest non-locked → should drop
            mkBullet("b3", 4),
        ])],
        projects: [mkProjectSel("pr-only", [mkBullet("b4", 2)])],
        education: [mkEducationSel("ed-only", [mkBullet("b5", 0)])],
    };
    const ids = getUnremovableEntityIds(sel);
    const step = pruneOneStep(sel, ids);
    if (!step || step.kind !== "bullet") {
        fail("expected a bullet prune step", step);
    } else {
        pass(`first prune dropped bullet: ${step.label}`);
    }
    if (sel.workRoles[0].bullets.find(b => b.bulletId === "b2")) {
        fail("b2 (lowest score) should have been dropped");
    } else {
        pass("b2 (lowest score) removed");
    }
    if (sel.workRoles[0].bullets.length !== 2) {
        fail(`expected 2 bullets remaining on wr-only, got ${sel.workRoles[0].bullets.length}`);
    } else {
        pass("wr-only down to 2 bullets");
    }
}

// 4) Bullet pruner never drops a locked bullet.
{
    const sel: ResumeSelection = {
        workRoles: [mkWorkRoleSel("wr-only", [
            mkBullet("b1", 1, true), // locked even though lowest non-zero
            mkBullet("b2", 5),
            mkBullet("b3", 3),
        ])],
        projects: [mkProjectSel("pr-only", [mkBullet("b4", 2)])],
        education: [mkEducationSel("ed-only", [mkBullet("b5", 0)])],
    };
    const ids = getUnremovableEntityIds(sel);
    const step = pruneOneStep(sel, ids);
    if (!step) { fail("expected a prune"); }
    if (!sel.workRoles[0].bullets.find(b => b.bulletId === "b1")) {
        fail("locked bullet b1 wrongly dropped");
    } else {
        pass("locked bullet b1 preserved through bullet-prune phase");
    }
    // b3 (score 3) is the lowest non-locked → should be dropped before b2 (5)
    if (sel.workRoles[0].bullets.find(b => b.bulletId === "b3")) {
        fail("b3 should have been dropped (lowest non-locked)");
    } else {
        pass("b3 dropped before b2");
    }
}

// 5) Entity with a locked bullet is itself unremovable even without the
//    explicit set (aggregateScore returns Infinity for locked-containing
//    entities). Demonstrate by configuring a low-score removable entity that
//    contains a locked bullet → should NOT be picked.
{
    const sel: ResumeSelection = {
        workRoles: [
            mkWorkRoleSel("wr-recent", [mkBullet("b1", 9)]),
            mkWorkRoleSel("wr-locked", [mkBullet("b2", 0, true)]),         // locked → Infinity agg
            mkWorkRoleSel("wr-zero", [mkBullet("b3", 0)]),                  // genuine lowest
        ],
        projects: [mkProjectSel("pr-top", [mkBullet("b4", 0)])],
        education: [mkEducationSel("ed-recent", [mkBullet("b5", 0)])],
    };
    const ids = getUnremovableEntityIds(sel);
    pruneOneStep(sel, ids);
    if (!sel.workRoles.find(g => g.entity.id === "wr-locked")) {
        fail("wr-locked (contains locked bullet) was dropped — should be infinite-score-protected");
    } else {
        pass("entity containing locked bullet is implicitly unremovable");
    }
    if (sel.workRoles.find(g => g.entity.id === "wr-zero")) {
        fail("wr-zero (genuine lowest, removable) should have been dropped");
    } else {
        pass("wr-zero dropped (correct lowest pick)");
    }
}

// 6) Pruner returns null when nothing else can be pruned.
{
    const sel: ResumeSelection = {
        workRoles: [mkWorkRoleSel("wr-only", [mkBullet("b1", 0)])],
        projects: [mkProjectSel("pr-only", [mkBullet("b2", 0)])],
        education: [mkEducationSel("ed-only", [mkBullet("b3", 0)])],
    };
    const ids = getUnremovableEntityIds(sel);
    const step = pruneOneStep(sel, ids);
    if (step !== null) {
        fail("expected null when no removable entities or droppable bullets remain", step);
    } else {
        pass("returns null when nothing more can be pruned");
    }
}

// 7) Section ordering: pruner picks the global lowest across sections, not
//    within a single section. A project at agg 0 beats a workRole at agg 3.
{
    const sel: ResumeSelection = {
        workRoles: [
            mkWorkRoleSel("wr-recent", [mkBullet("b1", 9)]),
            mkWorkRoleSel("wr-mid", [mkBullet("b2", 3)]),               // agg 3
        ],
        projects: [
            mkProjectSel("pr-top", [mkBullet("b3", 9)]),
            mkProjectSel("pr-zero", [mkBullet("b4", 0)]),               // agg 0 — should drop first
        ],
        education: [mkEducationSel("ed-recent", [mkBullet("b5", 0)])],
    };
    const ids = getUnremovableEntityIds(sel);
    const step = pruneOneStep(sel, ids);
    if (!step || step.kind !== "entity" || !step.label.includes("projects")) {
        fail("expected projects entity to drop first (global lowest)", step);
    } else {
        pass(`globally-lowest entity dropped first: ${step.label}`);
    }
    if (sel.projects.find(g => g.entity.id === "pr-zero")) {
        fail("pr-zero should have been removed");
    } else {
        pass("pr-zero removed (global lowest)");
    }
}

console.log(`\n${passes}/${passes + fails} steps passed`);
if (fails > 0) process.exit(1);
console.log("All checks passed.");
