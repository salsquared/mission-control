/**
 * One-shot cleanup for pre-fix imports that left duplicate entities on a
 * profile. Handles three failure modes the old import flow could produce:
 *
 *   (1) ROLE → PROJECT FOLD. An entity (e.g. "Space Enterprise at Berkeley",
 *       "Iris") was classified as a work role in one source resume and a
 *       project in another, producing both a WorkRole and a Project row.
 *
 *   (2) PROJECT ↔ PROJECT FOLD. Same project appears twice with a name-prefix
 *       mismatch — e.g. "Iris" + "Iris (Earth Observation Platform)".
 *
 *   (3) EDUCATION ↔ EDUCATION FOLD. Same institution under two name variants —
 *       e.g. "California State University, Long Beach" + "Cal State Long Beach".
 *
 * Optionally also: `--reorder-roles` reassigns WorkRole.position by startDate
 * desc so the timeline reads newest-first.
 *
 * The new synthesis + cross-category merge logic (lib/profile/synthesize.ts +
 * lib/profile/merge.ts) prevents all three going forward; this script tidies
 * what's already in the DB.
 *
 * Read-only by default. Pass `--confirm` to write.
 *
 *   # Dry-run
 *   DATABASE_URL="file:./prod.db"  npx tsx scripts/archive/migrations/dedupe-roles-projects-cross-category.ts
 *
 *   # Apply folds + reorder roles
 *   DATABASE_URL="file:./prod.db"  npx tsx scripts/archive/migrations/dedupe-roles-projects-cross-category.ts --confirm --reorder-roles
 *
 * Match keys for all folds use a prefix-with-word-boundary rule on normalized
 * (lowercase, alphanumeric-only) names: the shorter normalized name must
 * either equal the longer one or be a prefix followed by a space. Same rule
 * the live merge uses in lib/profile/merge.ts:findProjectByCompanyName.
 *
 * For project↔project and education↔education, the OLDER row (lower
 * `position`) is kept and the duplicate's bullets are merged into it; the
 * duplicate row is deleted. Description / repoUrl / liveUrl / degree / field
 * are filled in only when the keeper's value is null.
 *
 * Optional: --user-id=<userId> to limit to one user. Default: all users.
 */
import { prisma } from "@/lib/prisma";
import { parseBullets, serializeBullets } from "@/lib/profile/bullets";
import type { Bullet } from "@/lib/profile/types";

function norm(s: string | null | undefined): string {
    return (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function bulletKey(text: string): string {
    return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/** True if one normalized name is the other, OR is a prefix followed by a space. */
function prefixMatch(a: string, b: string): boolean {
    if (!a || !b) return false;
    if (a === b) return true;
    if (a.length > b.length) return a.startsWith(b + " ");
    return b.startsWith(a + " ");
}

function mergeBulletList(keeper: Bullet[], extra: Bullet[]): { merged: Bullet[]; added: number; deduped: number } {
    const seen = new Set(keeper.map(b => bulletKey(b.text)));
    const merged: Bullet[] = [...keeper];
    let added = 0;
    let deduped = 0;
    for (const b of extra) {
        const k = bulletKey(b.text);
        if (seen.has(k)) { deduped++; continue; }
        merged.push(b);
        seen.add(k);
        added++;
    }
    return { merged, added, deduped };
}

interface RoleToProjectPlan {
    kind: "role→project";
    profileId: string;
    userId: string;
    roleId: string;
    roleCompany: string;
    roleTitle: string;
    projectId: string;
    projectName: string;
    newBullets: Bullet[];
    addedBullets: number;
    dedupedBullets: number;
}

interface ProjectFoldPlan {
    kind: "project→project";
    profileId: string;
    userId: string;
    keeperId: string;
    keeperName: string;
    duplicateId: string;
    duplicateName: string;
    newBullets: Bullet[];
    addedBullets: number;
    dedupedBullets: number;
    descriptionFromDup: string | null;
    repoUrlFromDup: string | null;
    liveUrlFromDup: string | null;
}

interface EducationFoldPlan {
    kind: "education→education";
    profileId: string;
    userId: string;
    keeperId: string;
    keeperInstitution: string;
    duplicateId: string;
    duplicateInstitution: string;
    newBullets: Bullet[];
    addedBullets: number;
    dedupedBullets: number;
    degreeFromDup: string | null;
    fieldFromDup: string | null;
    startDate: Date | null;
    endDate: Date | null;
}

interface RoleReorderPlan {
    kind: "reorder-roles";
    profileId: string;
    userId: string;
    // Existing role id → new position. Only includes roles whose position actually changes.
    moves: Array<{ id: string; company: string; title: string; from: number; to: number }>;
}

async function main() {
    const confirm = process.argv.includes("--confirm");
    const reorderRoles = process.argv.includes("--reorder-roles");
    const userArg = process.argv.find(a => a.startsWith("--user-id="));
    const userIdFilter = userArg ? userArg.slice("--user-id=".length) : null;

    const profileWhere = userIdFilter ? { userId: userIdFilter } : {};
    const profiles = await prisma.profile.findMany({
        where: profileWhere,
        include: { workRoles: true, projects: true, education: true },
    });

    const rolePlans: RoleToProjectPlan[] = [];
    const projectPlans: ProjectFoldPlan[] = [];
    const educationPlans: EducationFoldPlan[] = [];
    const reorderPlans: RoleReorderPlan[] = [];

    for (const profile of profiles) {
        // ── (1) role → project ──────────────────────────────────────────
        const survivingRoles = new Set(profile.workRoles.map(w => w.id));
        for (const role of profile.workRoles) {
            for (const project of profile.projects) {
                if (!prefixMatch(norm(role.company), norm(project.name))) continue;
                const merged = mergeBulletList(parseBullets(project.bullets), parseBullets(role.bullets));
                rolePlans.push({
                    kind: "role→project",
                    profileId: profile.id, userId: profile.userId,
                    roleId: role.id, roleCompany: role.company, roleTitle: role.title,
                    projectId: project.id, projectName: project.name,
                    newBullets: merged.merged,
                    addedBullets: merged.added, dedupedBullets: merged.deduped,
                });
                survivingRoles.delete(role.id);
                break;  // each role folds into at most one project
            }
        }

        // ── (2) project ↔ project ──────────────────────────────────────
        // Walk pairs; the lower-position project is the keeper. Track already-
        // folded ids so we don't fold A→B and also B→C (B is gone).
        const folded = new Set<string>();
        const projectsSorted = [...profile.projects].sort((a, b) => a.position - b.position);
        for (let i = 0; i < projectsSorted.length; i++) {
            const keeper = projectsSorted[i];
            if (folded.has(keeper.id)) continue;
            for (let j = i + 1; j < projectsSorted.length; j++) {
                const dup = projectsSorted[j];
                if (folded.has(dup.id)) continue;
                if (!prefixMatch(norm(keeper.name), norm(dup.name))) continue;
                const merged = mergeBulletList(parseBullets(keeper.bullets), parseBullets(dup.bullets));
                projectPlans.push({
                    kind: "project→project",
                    profileId: profile.id, userId: profile.userId,
                    keeperId: keeper.id, keeperName: keeper.name,
                    duplicateId: dup.id, duplicateName: dup.name,
                    newBullets: merged.merged,
                    addedBullets: merged.added, dedupedBullets: merged.deduped,
                    descriptionFromDup: keeper.description ? null : dup.description,
                    repoUrlFromDup: keeper.repoUrl ? null : dup.repoUrl,
                    liveUrlFromDup: keeper.liveUrl ? null : dup.liveUrl,
                });
                folded.add(dup.id);
            }
        }

        // ── (3) education ↔ education ──────────────────────────────────
        const eduFolded = new Set<string>();
        const eduSorted = [...profile.education].sort((a, b) => a.position - b.position);
        for (let i = 0; i < eduSorted.length; i++) {
            const keeper = eduSorted[i];
            if (eduFolded.has(keeper.id)) continue;
            for (let j = i + 1; j < eduSorted.length; j++) {
                const dup = eduSorted[j];
                if (eduFolded.has(dup.id)) continue;
                if (!prefixMatch(norm(keeper.institution), norm(dup.institution))) continue;
                const merged = mergeBulletList(parseBullets(keeper.bullets), parseBullets(dup.bullets));
                // Widen date range: earliest start, latest end (null = ongoing wins).
                const startDate = (() => {
                    const a = keeper.startDate, b = dup.startDate;
                    if (!a) return b;
                    if (!b) return a;
                    return a.getTime() < b.getTime() ? a : b;
                })();
                const endDate = (() => {
                    if (keeper.endDate === null || dup.endDate === null) return null;
                    return keeper.endDate.getTime() > dup.endDate.getTime() ? keeper.endDate : dup.endDate;
                })();
                educationPlans.push({
                    kind: "education→education",
                    profileId: profile.id, userId: profile.userId,
                    keeperId: keeper.id, keeperInstitution: keeper.institution,
                    duplicateId: dup.id, duplicateInstitution: dup.institution,
                    newBullets: merged.merged,
                    addedBullets: merged.added, dedupedBullets: merged.deduped,
                    degreeFromDup: keeper.degree ? null : dup.degree,
                    fieldFromDup: keeper.field ? null : dup.field,
                    startDate, endDate,
                });
                eduFolded.add(dup.id);
            }
        }

        // ── (4) optional: reorder surviving work roles by startDate desc ──
        if (reorderRoles) {
            const survivors = profile.workRoles.filter(w => survivingRoles.has(w.id));
            const sorted = [...survivors].sort((a, b) => b.startDate.getTime() - a.startDate.getTime());
            const moves: RoleReorderPlan["moves"] = [];
            sorted.forEach((role, idx) => {
                const newPos = idx + 1;
                if (role.position !== newPos) {
                    moves.push({ id: role.id, company: role.company, title: role.title, from: role.position, to: newPos });
                }
            });
            if (moves.length > 0) {
                reorderPlans.push({
                    kind: "reorder-roles",
                    profileId: profile.id, userId: profile.userId,
                    moves,
                });
            }
        }
    }

    const totalPlans = rolePlans.length + projectPlans.length + educationPlans.length + reorderPlans.length;
    if (totalPlans === 0) {
        console.log("Nothing to clean up.");
        return;
    }

    if (rolePlans.length > 0) {
        console.log(`\n── ROLE → PROJECT (${rolePlans.length}) ──`);
        for (const p of rolePlans) {
            console.log(`  user=${p.userId}`);
            console.log(`    role:    "${p.roleCompany}" — ${p.roleTitle} (id=${p.roleId})`);
            console.log(`    project: "${p.projectName}" (id=${p.projectId})`);
            console.log(`    bullets: +${p.addedBullets}, deduped ${p.dedupedBullets}`);
        }
    }
    if (projectPlans.length > 0) {
        console.log(`\n── PROJECT → PROJECT (${projectPlans.length}) ──`);
        for (const p of projectPlans) {
            console.log(`  user=${p.userId}`);
            console.log(`    keep: "${p.keeperName}" (id=${p.keeperId})`);
            console.log(`    drop: "${p.duplicateName}" (id=${p.duplicateId})`);
            console.log(`    bullets: +${p.addedBullets}, deduped ${p.dedupedBullets}`);
            if (p.descriptionFromDup) console.log(`    description ← duplicate`);
            if (p.repoUrlFromDup) console.log(`    repoUrl ← duplicate`);
            if (p.liveUrlFromDup) console.log(`    liveUrl ← duplicate`);
        }
    }
    if (educationPlans.length > 0) {
        console.log(`\n── EDUCATION → EDUCATION (${educationPlans.length}) ──`);
        for (const p of educationPlans) {
            console.log(`  user=${p.userId}`);
            console.log(`    keep: "${p.keeperInstitution}" (id=${p.keeperId})`);
            console.log(`    drop: "${p.duplicateInstitution}" (id=${p.duplicateId})`);
            console.log(`    bullets: +${p.addedBullets}, deduped ${p.dedupedBullets}`);
            if (p.degreeFromDup) console.log(`    degree ← duplicate: ${p.degreeFromDup}`);
            if (p.fieldFromDup) console.log(`    field ← duplicate: ${p.fieldFromDup}`);
        }
    }
    if (reorderPlans.length > 0) {
        console.log(`\n── WORK-ROLE POSITION REORDER (${reorderPlans.length} profile(s)) ──`);
        for (const p of reorderPlans) {
            console.log(`  user=${p.userId}`);
            for (const m of p.moves) {
                console.log(`    ${m.from} → ${m.to}: "${m.company}" — ${m.title}`);
            }
        }
    }

    if (!confirm) {
        console.log("\n[DRY RUN] Re-run with --confirm to apply.");
        return;
    }

    let projectUpdates = 0;
    let rolesDeleted = 0;
    let projectsDeleted = 0;
    let educationUpdates = 0;
    let educationDeleted = 0;
    let rolePositionUpdates = 0;

    for (const p of rolePlans) {
        await prisma.$transaction([
            prisma.project.update({ where: { id: p.projectId }, data: { bullets: serializeBullets(p.newBullets) } }),
            prisma.workRole.delete({ where: { id: p.roleId } }),
        ]);
        projectUpdates++;
        rolesDeleted++;
    }

    for (const p of projectPlans) {
        const updates: Record<string, unknown> = { bullets: serializeBullets(p.newBullets) };
        if (p.descriptionFromDup) updates.description = p.descriptionFromDup;
        if (p.repoUrlFromDup) updates.repoUrl = p.repoUrlFromDup;
        if (p.liveUrlFromDup) updates.liveUrl = p.liveUrlFromDup;
        await prisma.$transaction([
            prisma.project.update({ where: { id: p.keeperId }, data: updates }),
            prisma.project.delete({ where: { id: p.duplicateId } }),
        ]);
        projectUpdates++;
        projectsDeleted++;
    }

    for (const p of educationPlans) {
        const updates: Record<string, unknown> = { bullets: serializeBullets(p.newBullets) };
        if (p.degreeFromDup) updates.degree = p.degreeFromDup;
        if (p.fieldFromDup) updates.field = p.fieldFromDup;
        if (p.startDate) updates.startDate = p.startDate;
        if (p.endDate) updates.endDate = p.endDate;
        await prisma.$transaction([
            prisma.education.update({ where: { id: p.keeperId }, data: updates }),
            prisma.education.delete({ where: { id: p.duplicateId } }),
        ]);
        educationUpdates++;
        educationDeleted++;
    }

    // Reorder roles AFTER role→project folds so the surviving set is correct.
    // SQLite has no transactional rename trick — we do two passes via a
    // temporary offset so we never collide on the live position values.
    for (const p of reorderPlans) {
        const OFFSET = 10_000;
        const movesById = new Map(p.moves.map(m => [m.id, m]));
        // Reload surviving roles to be safe — role→project folds may have run.
        const survivors = await prisma.workRole.findMany({
            where: { profileId: p.profileId, id: { in: [...movesById.keys()] } },
            select: { id: true },
        });
        if (survivors.length === 0) continue;
        await prisma.$transaction(async (tx) => {
            for (const s of survivors) {
                const m = movesById.get(s.id);
                if (!m) continue;
                await tx.workRole.update({ where: { id: s.id }, data: { position: m.to + OFFSET } });
            }
            for (const s of survivors) {
                const m = movesById.get(s.id);
                if (!m) continue;
                await tx.workRole.update({ where: { id: s.id }, data: { position: m.to } });
                rolePositionUpdates++;
            }
        });
    }

    console.log(
        `\nDone. ` +
        `Projects updated: ${projectUpdates}. ` +
        `Roles deleted: ${rolesDeleted}. ` +
        `Project duplicates deleted: ${projectsDeleted}. ` +
        `Education updated: ${educationUpdates}. ` +
        `Education duplicates deleted: ${educationDeleted}. ` +
        `Role positions reassigned: ${rolePositionUpdates}.`,
    );
}

main()
    .catch(e => { console.error(e); process.exit(1); })
    .finally(() => prisma.$disconnect());
