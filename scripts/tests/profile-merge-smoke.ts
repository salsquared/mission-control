/**
 * Hermetic unit tests for lib/profile/merge.ts. No DB, no AI, no env vars.
 *
 *   npx tsx scripts/tests/profile-merge-smoke.ts
 *
 * The merge function is the load-bearing piece of M7.4 (story 30a). Each
 * test exercises one merge-key or dedup behavior in isolation.
 */
import { mergeImports, type ExistingProfileForMerge } from "@/lib/profile/merge";
import type { ExtractedProfile } from "@/lib/profile/import-llm";
import { makeBullet } from "@/lib/profile/bullets";

let passes = 0;
let fails = 0;
function pass(msg: string) { console.log(`[PASS] ${msg}`); passes++; }
function fail(msg: string, detail?: unknown) { console.error(`[FAIL] ${msg}`, detail ?? ""); fails++; }

function emptyExisting(): ExistingProfileForMerge {
    return {
        headline: null, summary: null, location: null, email: null, phone: null, links: null,
        workRoles: [], projects: [], education: [],
    };
}

function emptyIncoming(): ExtractedProfile {
    return {
        header: { headline: null, summary: null, location: null, email: null, phone: null, links: null },
        workRoles: [], projects: [], education: [],
    };
}

// ─── Header merge ────────────────────────────────────────────────────────

{
    const existing = emptyExisting();
    existing.email = "old@example.com"; // pre-existing
    const incoming = emptyIncoming();
    incoming.header = {
        headline: "Senior Engineer",
        summary: null,
        location: "Brooklyn, NY",
        email: "new@example.com",  // shouldn't overwrite existing
        phone: "555-1212",
        links: [{ label: "GitHub", url: "https://github.com/u" }],
    };
    const r = mergeImports(existing, [{ filename: "a.pdf", tree: incoming }]);
    if (!r.headerPatch) { fail("expected header patch"); }
    else {
        if (r.headerPatch.headline !== "Senior Engineer") fail("headline not filled");
        else pass("header: empty headline filled from incoming");
        if (r.headerPatch.location !== "Brooklyn, NY") fail("location not filled");
        else pass("header: empty location filled");
        if (r.headerPatch.phone !== "555-1212") fail("phone not filled");
        else pass("header: empty phone filled");
        // The existing email must NOT be overwritten
        if (r.headerPatch.email !== undefined) fail("header email shouldn't overwrite existing");
        else pass("header: existing email preserved (no overwrite)");
        if (!r.headerPatch.links || r.headerPatch.links.length !== 1) fail("links not merged");
        else pass("header: links merged");
    }
}

// ─── Work-role match key: (company, title) normalized ────────────────────

{
    const existing = emptyExisting();
    existing.workRoles = [{
        id: "wr-existing",
        company: "Acme Corp",
        title: "Senior Engineer",
        location: null,
        startDate: new Date("2023-01-01"),
        endDate: null,
        bullets: [makeBullet("Original bullet")],
    }];
    const incoming = emptyIncoming();
    incoming.workRoles = [{
        company: "  ACME   corp  ", // normalized: case + whitespace
        title: "senior engineer",
        location: null,
        startDate: "2023-06-01T00:00:00.000Z", // overlaps
        endDate: null,
        bullets: ["New bullet from import"],
    }];
    const r = mergeImports(existing, [{ filename: "a.pdf", tree: incoming }]);
    if (r.workRoleUpdates.length !== 1) fail(`expected 1 work-role update via match, got ${r.workRoleUpdates.length}`);
    else pass("work-role match: normalized company+title matches");
    if (r.workRolesToCreate.length !== 0) fail("shouldn't create a new role on match");
    else pass("work-role match: no duplicate row created");
    if (r.workRoleUpdates[0]?.bullets.length !== 2) fail(`expected merged bullets = 2, got ${r.workRoleUpdates[0]?.bullets.length}`);
    else pass("work-role match: bullets merged");
}

// ─── Work-role: date-overlap tiebreaker for same company/title ───────────

{
    const existing = emptyExisting();
    existing.workRoles = [{
        id: "wr-old",
        company: "Acme",
        title: "Engineer",
        location: null,
        startDate: new Date("2020-01-01"),
        endDate: new Date("2021-01-01"),
        bullets: [],
    }];
    const incoming = emptyIncoming();
    incoming.workRoles = [{
        company: "Acme",
        title: "Engineer",
        location: null,
        startDate: "2023-01-01T00:00:00.000Z", // no overlap with 2020-21
        endDate: null,
        bullets: ["fresh stint"],
    }];
    const r = mergeImports(existing, [{ filename: "a.pdf", tree: incoming }]);
    if (r.workRolesToCreate.length !== 1) fail("date non-overlap should create a new role");
    else pass("work-role match: non-overlapping dates → new role created");
    if (r.workRoleUpdates.length !== 0) fail("non-overlap shouldn't update existing");
    else pass("work-role match: existing role left alone");
}

// ─── Bullet dedup: exact text match ──────────────────────────────────────

{
    const existing = emptyExisting();
    existing.workRoles = [{
        id: "wr1",
        company: "X", title: "Y",
        location: null, startDate: new Date("2024-01-01"), endDate: null,
        bullets: [makeBullet("Built TypeScript service"), makeBullet("Mentored juniors")],
    }];
    const incoming = emptyIncoming();
    incoming.workRoles = [{
        company: "X", title: "Y",
        location: null, startDate: "2024-01-01", endDate: null,
        bullets: [
            "Built TypeScript service",       // exact match — dedup
            "  Built   TypeScript service  ", // whitespace variant — dedup via normalization
            "BUILT TYPESCRIPT SERVICE",       // case variant — dedup
            "New unique bullet",
        ],
    }];
    const r = mergeImports(existing, [{ filename: "a.pdf", tree: incoming }]);
    if (r.counts.bulletsDeduped !== 3) fail(`expected 3 deduped, got ${r.counts.bulletsDeduped}`);
    else pass("bullet dedup: 3 case/whitespace variants collapsed");
    if (r.counts.bulletsAdded !== 1) fail(`expected 1 added, got ${r.counts.bulletsAdded}`);
    else pass("bullet dedup: 1 new bullet appended");
    if (r.workRoleUpdates[0]?.bullets.length !== 3) fail("merged bullets count wrong");
    else pass("bullet dedup: final bullets array is 2 existing + 1 new = 3");
}

// ─── Project match: name + repoUrl tiebreaker ────────────────────────────

{
    const existing = emptyExisting();
    existing.projects = [{
        id: "p1", name: "mission-control",
        description: null, repoUrl: "https://github.com/u/mission-control", liveUrl: null,
        bullets: [],
    }];
    const incoming = emptyIncoming();
    incoming.projects = [{
        name: "mission-control",  // same name
        description: null, repoUrl: "https://github.com/u/mission-control", liveUrl: null,
        bullets: ["new project bullet"],
    }];
    const r = mergeImports(existing, [{ filename: "a.pdf", tree: incoming }]);
    if (r.projectUpdates.length !== 1) fail("project match by name+repoUrl should update");
    else pass("project match: same name + same repoUrl → merged");
    if (r.projectsToCreate.length !== 0) fail("shouldn't create dup project");
    else pass("project match: no duplicate created");
}

// ─── Project: different repoUrl → considered different ─────────────────

{
    const existing = emptyExisting();
    existing.projects = [{
        id: "p1", name: "side-project",
        description: null, repoUrl: "https://github.com/u/side-project", liveUrl: null,
        bullets: [],
    }];
    const incoming = emptyIncoming();
    incoming.projects = [{
        name: "side-project",
        description: null, repoUrl: "https://github.com/other/side-project", liveUrl: null,
        bullets: ["different fork"],
    }];
    const r = mergeImports(existing, [{ filename: "a.pdf", tree: incoming }]);
    if (r.projectsToCreate.length !== 1) fail("different repoUrl should create new row");
    else pass("project match: different repoUrl creates a new project");
}

// ─── Education match: (institution, degree, field) ──────────────────────

{
    const existing = emptyExisting();
    existing.education = [{
        id: "e1", institution: "State U", degree: "BS", field: "CS",
        startDate: new Date("2018-01-01"), endDate: new Date("2022-01-01"),
        bullets: [],
    }];
    const incoming = emptyIncoming();
    incoming.education = [{
        institution: "  state u  ", degree: "bs", field: "cs",
        startDate: "2018-01-01", endDate: "2022-01-01",
        bullets: ["GPA 3.8"],
    }];
    const r = mergeImports(existing, [{ filename: "a.pdf", tree: incoming }]);
    if (r.educationUpdates.length !== 1) fail("education triple-key normalization failed");
    else pass("education match: normalized triple-key matches");
}

// ─── Dropped-no-startDate counter (#7 in code-review) ────────────────────

{
    const existing = emptyExisting();
    const incoming = emptyIncoming();
    incoming.workRoles = [{
        company: "Mystery Co", title: "Engineer",
        location: null, startDate: null, endDate: null,  // no startDate
        bullets: ["a bullet"],
    }];
    const r = mergeImports(existing, [{ filename: "a.pdf", tree: incoming }]);
    if (r.counts.workRolesDroppedNoStartDate !== 1) fail(`expected 1 dropped, got ${r.counts.workRolesDroppedNoStartDate}`);
    else pass("dropped-no-startDate: count surfaced");
    if (r.workRolesToCreate.length !== 0) fail("shouldn't create a role without startDate");
    else pass("dropped-no-startDate: no row created");
}

// ─── In-batch dedup: same role appears in two files of the same import ──

{
    const existing = emptyExisting();
    const fileA: ExtractedProfile = {
        ...emptyIncoming(),
        workRoles: [{
            company: "Acme", title: "Engineer",
            location: null, startDate: "2024-01-01", endDate: null,
            bullets: ["bullet from file A"],
        }],
    };
    const fileB: ExtractedProfile = {
        ...emptyIncoming(),
        workRoles: [{
            company: "Acme", title: "Engineer",
            location: null, startDate: "2024-01-01", endDate: null,
            bullets: ["bullet from file B"],
        }],
    };
    const r = mergeImports(existing, [
        { filename: "a.pdf", tree: fileA },
        { filename: "b.docx", tree: fileB },
    ]);
    if (r.workRolesToCreate.length !== 1) fail(`in-batch dedup failed: expected 1 create, got ${r.workRolesToCreate.length}`);
    else pass("in-batch dedup: 2 files with same role create 1 row");
    if (r.workRolesToCreate[0]?.bullets.length !== 2) fail("bullets from both files should be on the created row");
    else pass("in-batch dedup: bullets from both files preserved");
}

// ─── Counts roll up across multiple files ───────────────────────────────

{
    const existing = emptyExisting();
    const f1: ExtractedProfile = { ...emptyIncoming(), workRoles: [{ company: "C1", title: "T1", location: null, startDate: "2024-01-01", endDate: null, bullets: ["x"] }] };
    const f2: ExtractedProfile = { ...emptyIncoming(), workRoles: [{ company: "C2", title: "T2", location: null, startDate: "2024-01-01", endDate: null, bullets: ["y"] }] };
    const r = mergeImports(existing, [
        { filename: "f1.pdf", tree: f1 },
        { filename: "f2.pdf", tree: f2 },
    ]);
    if (r.counts.workRolesAdded !== 2) fail(`total workRolesAdded: expected 2, got ${r.counts.workRolesAdded}`);
    else pass("counts: sum across files");
    if (r.perFile.length !== 2) fail("perFile should have 2 entries");
    else if (r.perFile[0].counts.workRolesAdded !== 1 || r.perFile[1].counts.workRolesAdded !== 1) {
        fail("per-file counts wrong");
    } else {
        pass("counts: per-file breakdown correct");
    }
}

console.log(`\n${passes}/${passes + fails} steps passed`);
if (fails > 0) process.exit(1);
console.log("All checks passed.");
