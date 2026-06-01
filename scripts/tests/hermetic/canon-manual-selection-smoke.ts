/**
 * Hermetic smoke for the manual resume-builder's data layer
 * (docs/archive/resume-manual-builder.html, task P4.1):
 *
 *   - lib/canons/selection.ts:resolveSelection / resolveExtras (pure functions)
 *   - lib/repositories/canons.ts:getCanonSelection / saveCanonSelection +
 *     the serializeCanon `hasSelection` flag (DB round-trip).
 *
 * Parts 1 & 2 are pure (in-memory ProfileWire + a CanonSelection parsed via
 * CanonSelectionSchema) — no DB. Part 3 seeds a throwaway user + profile +
 * canon in dev.db and tears them down via the user's onDelete cascade in
 * `finally`, leaving ZERO orphan rows.
 *
 * Run: DATABASE_URL="file:./dev.db" npx tsx scripts/tests/hermetic/canon-manual-selection-smoke.ts
 */
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import type { ProfileWire } from "@/lib/schemas/profile";
import { CanonSelectionSchema } from "@/lib/schemas/canons";
import { resolveSelection, resolveExtras } from "@/lib/canons/selection";
import {
    createCanon,
    getCanon,
    getCanonSelection,
    saveCanonSelection,
} from "@/lib/repositories/canons";

let passes = 0;
let fails = 0;
function ok(msg: string, cond: boolean, detail?: unknown) {
    if (cond) { console.log(`[PASS] ${msg}`); passes++; }
    else { console.error(`[FAIL] ${msg}`, detail ?? ""); fails++; }
}

const now = new Date().toISOString();

function mkBullet(id: string, text: string, tags: string[] = []) {
    return { id, text, tags, autoTags: [], removedTags: [], pinnedTags: [], locked: false, excluded: false };
}

// ─── In-memory profile (pure-function fixture) ──────────────────────────────
// Two work roles, one project, one education — with bullets in a known order
// so we can assert profile-order rendering + membership filtering.
const profile: ProfileWire = {
    id: "p1",
    userId: "u1",
    headline: "Engineer",
    tagline: null,
    location: null,
    email: null,
    phone: null,
    links: null,
    skills: [
        { category: "Languages", items: ["TypeScript", "Python", "Rust"] },
        { category: "Cloud", items: ["AWS", "GCP"] },
    ],
    hobbies: ["Climbing", "Chess", "Photography"],
    languages: [
        { name: "English", proficiency: "Native" },
        { name: "Spanish", proficiency: "Professional" },
        { name: "French", proficiency: "Basic" },
    ],
    workRoles: [
        {
            id: "wr1",
            profileId: "p1",
            company: "Recent Co",
            title: "Senior Engineer",
            location: null,
            startDate: "2024-01-01T00:00:00.000Z",
            endDate: null,
            bullets: [
                mkBullet("b1", "Built a Kubernetes deployment pipeline", ["kubernetes", "devops"]),
                mkBullet("b2", "Wrote a Python ETL service", ["python", "etl"]),
                mkBullet("b3", "Mentored junior engineers", ["leadership"]),
            ],
            scratchpad: null,
            pinKeywords: null,
            position: 0,
            createdAt: now,
            updatedAt: now,
        },
        {
            id: "wr2",
            profileId: "p1",
            company: "Older Co",
            title: "Intern",
            location: null,
            startDate: "2022-01-01T00:00:00.000Z",
            endDate: "2022-08-01T00:00:00.000Z",
            bullets: [
                mkBullet("b4", "Triaged support tickets", ["support"]),
            ],
            scratchpad: null,
            pinKeywords: null,
            position: 1,
            createdAt: now,
            updatedAt: now,
        },
    ],
    projects: [
        {
            id: "pr1",
            profileId: "p1",
            name: "Open-source CLI",
            description: null,
            repoUrl: null,
            liveUrl: null,
            bullets: [
                mkBullet("b5", "Authored a Rust CLI used by 200+ devs", ["rust", "cli"]),
                mkBullet("b6", "Set up CI with GitHub Actions", ["ci"]),
            ],
            scratchpad: null,
            pinKeywords: null,
            position: 0,
            createdAt: now,
            updatedAt: now,
        },
    ],
    education: [
        {
            id: "ed1",
            profileId: "p1",
            institution: "State University",
            degree: "BS Computer Science",
            field: "CS",
            startDate: "2018-01-01T00:00:00.000Z",
            endDate: "2022-01-01T00:00:00.000Z",
            bullets: [
                mkBullet("b7", "GPA 3.8, focus on distributed systems", ["systems"]),
            ],
            scratchpad: null,
            pinKeywords: null,
            position: 0,
            createdAt: now,
            updatedAt: now,
        },
    ],
    createdAt: now,
    updatedAt: now,
};

function runPureTests() {
    console.log("── Part 1: resolveSelection ──────────────────────────────");

    // Selection: include wr1 (b2,b1 — out of profile order, references a
    // deleted bullet "ghost"), wr2 absent, pr1 (b5 only), ed1 (b7), plus a
    // bogus entity key ("ghost-entity") that isn't in the profile.
    const selection = CanonSelectionSchema.parse({
        entities: {
            wr1: { kind: "workRole", bulletIds: ["b2", "b1", "deleted-bullet-id"] },
            pr1: { kind: "project", bulletIds: ["b5"] },
            ed1: { kind: "education", bulletIds: ["b7"] },
            "ghost-entity": { kind: "workRole", bulletIds: ["x"] },
        },
        extras: {
            skillItems: ["TypeScript", "AWS", "Haskell"], // Haskell not in profile → dropped
            languages: ["English", "Klingon"],            // Klingon not in profile → dropped
            hobbies: ["Chess", "Skydiving"],              // Skydiving not in profile → dropped
        },
    });

    const resolved = resolveSelection(profile, selection);

    // 1a) Only entities present in `selection.entities` render. wr2 absent →
    //     not rendered. ghost-entity not in profile → dropped (best-effort).
    ok("only included work roles render (wr1 yes, wr2 no)",
        resolved.workRoles.length === 1 && resolved.workRoles[0]?.entity.id === "wr1");
    ok("included project renders (pr1)",
        resolved.projects.length === 1 && resolved.projects[0]?.entity.id === "pr1");
    ok("included education renders (ed1)",
        resolved.education.length === 1 && resolved.education[0]?.entity.id === "ed1");
    ok("ghost entity key (not in profile) is dropped — no extra work role",
        resolved.workRoles.every((e) => e.entity.id !== "ghost-entity"));

    // 1b) Bullets are only the chosen ones, in PROFILE bullet order (b1 before
    //     b2 in profile), not the selection's listed order (b2 then b1).
    const wr1Bullets = resolved.workRoles[0]?.bullets ?? [];
    ok("wr1 renders only chosen bullets (b1,b2 — b3 excluded from selection)",
        wr1Bullets.length === 2);
    ok("wr1 bullets are in PROFILE order (b1 before b2), not selection order",
        wr1Bullets[0]?.bulletId === "b1" && wr1Bullets[1]?.bulletId === "b2");

    // 1c) A bulletIds entry referencing a deleted bullet is silently dropped.
    ok("deleted bullet id ('deleted-bullet-id') is dropped, not rendered",
        wr1Bullets.every((b) => b.bulletId !== "deleted-bullet-id"));

    // 1d) Manual bullets are unscored when no keywords are passed.
    const allBullets = [
        ...resolved.workRoles.flatMap((e) => e.bullets),
        ...resolved.projects.flatMap((e) => e.bullets),
        ...resolved.education.flatMap((e) => e.bullets),
    ];
    ok("all manual bullets have score === 0",
        allBullets.every((b) => b.score === 0));
    ok("all manual bullets have locked === false",
        allBullets.every((b) => b.locked === false));
    ok("no-keywords: matchedTags + matchedKeywords are empty",
        allBullets.every((b) => b.matchedTags.length === 0 && b.matchedKeywords.length === 0));

    // 1e) sourceLabel is correct per kind.
    ok("workRole sourceLabel = '<title> @ <company>'",
        wr1Bullets[0]?.sourceLabel === "Senior Engineer @ Recent Co");
    ok("project sourceLabel = name",
        resolved.projects[0]?.bullets[0]?.sourceLabel === "Open-source CLI");
    ok("education sourceLabel = '<degree> <institution>'",
        resolved.education[0]?.bullets[0]?.sourceLabel === "BS Computer Science State University");

    // 1f) WITH keywords, a matching bullet gets non-empty matchedKeywords/Tags.
    //     "python" is both a tag and a text token on b2; "kubernetes" tags b1.
    const resolvedKw = resolveSelection(profile, selection, ["python", "kubernetes"]);
    const kwB2 = resolvedKw.workRoles[0]?.bullets.find((b) => b.bulletId === "b2");
    const kwB1 = resolvedKw.workRoles[0]?.bullets.find((b) => b.bulletId === "b1");
    ok("with keywords: b2 (Python ETL, tag 'python') has non-empty matchedKeywords",
        (kwB2?.matchedKeywords.length ?? 0) > 0, kwB2?.matchedKeywords);
    ok("with keywords: b2 has non-empty matchedTags (tag 'python')",
        (kwB2?.matchedTags.length ?? 0) > 0, kwB2?.matchedTags);
    ok("with keywords: b1 (tag 'kubernetes') has non-empty matchedTags",
        (kwB1?.matchedTags.length ?? 0) > 0, kwB1?.matchedTags);
    ok("with keywords: score still 0 (manual never scores inclusion)",
        (kwB2?.score === 0) && (kwB1?.score === 0));

    console.log("── Part 2: resolveExtras ─────────────────────────────────");
    const extras = resolveExtras(profile, selection);

    // 2a) skill groups keep only chosen items; a group with zero survivors drops.
    //     Chosen: TypeScript (Languages), AWS (Cloud), Haskell (not in profile).
    //     Languages group → [TypeScript]; Cloud → [AWS]. No empty group survives.
    const langGroup = extras.skills.find((g) => g.category === "Languages");
    const cloudGroup = extras.skills.find((g) => g.category === "Cloud");
    ok("skills: Languages group kept only chosen item (TypeScript)",
        !!langGroup && langGroup.items.length === 1 && langGroup.items[0] === "TypeScript");
    ok("skills: Cloud group kept only chosen item (AWS)",
        !!cloudGroup && cloudGroup.items.length === 1 && cloudGroup.items[0] === "AWS");
    ok("skills: a not-in-profile pick (Haskell) is dropped",
        extras.skills.every((g) => !g.items.includes("Haskell")));

    // 2b) a skill group with zero surviving chosen items drops entirely.
    const selectionNoCloud = CanonSelectionSchema.parse({
        entities: {},
        extras: { skillItems: ["TypeScript"], languages: [], hobbies: [] },
    });
    const extrasNoCloud = resolveExtras(profile, selectionNoCloud);
    ok("skills: a group with zero chosen items drops entirely (Cloud gone)",
        extrasNoCloud.skills.every((g) => g.category !== "Cloud") && extrasNoCloud.skills.length === 1);

    // 2c) languages keep only chosen names; not-in-profile dropped.
    const langNames = extras.languages.map((l) => l.name);
    ok("languages: keeps only chosen (English), drops the rest + the bogus one",
        langNames.length === 1 && langNames[0] === "English");

    // 2d) hobbies keep only chosen; not-in-profile dropped.
    ok("hobbies: keeps only chosen (Chess), drops Skydiving (not in profile)",
        extras.hobbies.length === 1 && extras.hobbies[0] === "Chess");
}

// ─── Part 3: repo round-trip against dev.db ─────────────────────────────────
async function runRepoTests() {
    console.log("── Part 3: repo round-trip (getCanonSelection / saveCanonSelection) ──");

    const TEST_USER_ID = `canon-msel-smoke-${randomUUID()}`;
    let otherUserId: string | null = null;

    await prisma.user.create({ data: { id: TEST_USER_ID, email: `${TEST_USER_ID}@test.invalid` } });
    try {
        // A profile (cascades away with the user); exercises the "+ profile"
        // hygiene the task asks for, even though the repo fns don't read it.
        await prisma.profile.create({ data: { userId: TEST_USER_ID, headline: "Smoke" } });

        const canon = await createCanon(TEST_USER_ID, {
            name: `Smoke Manual Canon ${Date.now()}`,
            track: "career",
            keywords: "python OR typescript",
        });

        // 3a) Before any save: getCanonSelection → null; hasSelection false.
        ok("getCanonSelection returns null before any save",
            (await getCanonSelection(TEST_USER_ID, canon.id)) === null);
        const before = await getCanon(TEST_USER_ID, canon.id);
        ok("hasSelection is false before save", before?.hasSelection === false);

        // 3b) Save a selection → true; round-trips deep-equal through JSON.
        const selection = CanonSelectionSchema.parse({
            sectionsOff: ["interests"],
            entities: {
                wr1: { kind: "workRole", bulletIds: ["b1", "b2"] },
                ed1: { kind: "education", bulletIds: ["b7"] },
            },
            excluded: ["wr2", "pr1"],
            extras: {
                skillItems: ["TypeScript", "AWS"],
                languages: ["English"],
                hobbies: ["Chess"],
            },
        });
        ok("saveCanonSelection returns true for an owned canon",
            (await saveCanonSelection(TEST_USER_ID, canon.id, selection)) === true);

        const loaded = await getCanonSelection(TEST_USER_ID, canon.id);
        ok("getCanonSelection round-trips deep-equal to what was saved",
            JSON.stringify(loaded) === JSON.stringify(selection),
            { saved: selection, loaded });
        ok("round-trip preserves the `excluded` id-list",
            JSON.stringify(loaded?.excluded) === JSON.stringify(["wr2", "pr1"]));

        // 3c) hasSelection flips true after save.
        const after = await getCanon(TEST_USER_ID, canon.id);
        ok("hasSelection is true after save", after?.hasSelection === true);

        // 3d) save for a canon the user doesn't own → false.
        const other = await prisma.user.create({
            data: { id: `canon-msel-smoke-other-${randomUUID()}`, email: `other-${randomUUID()}@test.invalid` },
        });
        otherUserId = other.id;
        ok("saveCanonSelection for a canon the user doesn't own → false",
            (await saveCanonSelection(otherUserId, canon.id, selection)) === false);
        ok("saveCanonSelection for a nonexistent canon id → false",
            (await saveCanonSelection(TEST_USER_ID, `nope-${randomUUID()}`, selection)) === false);
        // ...and the non-owner write did NOT clobber the real selection.
        const stillThere = await getCanonSelection(TEST_USER_ID, canon.id);
        ok("non-owner save did not mutate the owner's selection",
            JSON.stringify(stillThere) === JSON.stringify(selection));

        // 3e) Corrupt JSON in the column → getCanonSelection returns null (lenient).
        await prisma.canon.update({ where: { id: canon.id }, data: { selection: "{not valid json" } });
        let threw = false;
        let corruptResult: unknown = "unset";
        try {
            corruptResult = await getCanonSelection(TEST_USER_ID, canon.id);
        } catch {
            threw = true;
        }
        ok("corrupt JSON: getCanonSelection does not throw", !threw);
        ok("corrupt JSON: getCanonSelection returns null (lenient parse)", corruptResult === null);
    } finally {
        // onDelete: Cascade from User → Profile + Canon, so deleting the
        // throwaway users removes every seeded row. No orphans.
        await prisma.user.delete({ where: { id: TEST_USER_ID } }).catch(() => {});
        if (otherUserId) await prisma.user.delete({ where: { id: otherUserId } }).catch(() => {});
    }
}

async function main() {
    try {
        runPureTests();
        await runRepoTests();
    } finally {
        await prisma.$disconnect();
    }
    console.log(`\n${passes} passed, ${fails} failed`);
    process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
