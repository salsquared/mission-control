/**
 * Deterministic smoke for lib/resumes/select.ts. No DB, no AI, no env vars.
 *
 *   npx tsx scripts/tests/hermetic/resume-select-smoke.ts
 */
import type { ProfileWire } from "@/lib/schemas/profile";
import { selectBullets, flattenSelections } from "@/lib/resumes/select";

let passes = 0;
let fails = 0;
function pass(msg: string) { console.log(`[PASS] ${msg}`); passes++; }
function fail(msg: string, detail?: unknown) { console.error(`[FAIL] ${msg}`, detail ?? ""); fails++; }

const now = new Date().toISOString();

function mkBullet(id: string, text: string, tags: string[] = [], flags: { locked?: boolean; excluded?: boolean } = {}) {
    return { id, text, tags, autoTags: [], removedTags: [], locked: flags.locked ?? false, excluded: flags.excluded ?? false };
}

const profile: ProfileWire = {
    id: "p1",
    userId: "u1",
    headline: "Engineer",
    summary: null,
    location: null,
    email: null,
    phone: null,
    links: null,
    workRoles: [
        {
            id: "wr1",
            profileId: "p1",
            company: "Recent Co",
            title: "Engineer",
            location: null,
            startDate: "2024-01-01T00:00:00.000Z",
            endDate: null,
            bullets: [
                mkBullet("b1", "Built a TypeScript service in Node", ["typescript", "node"]),
                mkBullet("b2", "Wrote a Python ETL pipeline with pandas", ["python", "etl"]),
                mkBullet("b3", "Reviewed PRs and mentored juniors", ["leadership"]),
                mkBullet("b4", "Locked accomplishment that must always appear", [], { locked: true }),
                mkBullet("b5", "Excluded bullet that should never appear", ["typescript"], { excluded: true }),
            ],
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
                mkBullet("b6", "Random unrelated work", ["unrelated"]),
            ],
            position: 1,
            createdAt: now,
            updatedAt: now,
        },
    ],
    projects: [
        {
            id: "pr1",
            profileId: "p1",
            name: "Open-source Go library",
            description: null,
            repoUrl: null,
            liveUrl: null,
            bullets: [
                mkBullet("b7", "Authored a Go library used by 200+ devs", ["go"]),
                mkBullet("b8", "Optimized TypeScript build pipeline", ["typescript"]),
            ],
            metrics: null,
            githubRepo: null,
            portfolio: false,
            metricsUpdatedAt: null,
            position: 0,
            createdAt: now,
            updatedAt: now,
        },
        {
            id: "pr2",
            profileId: "p1",
            name: "Side game",
            description: null,
            repoUrl: null,
            liveUrl: null,
            bullets: [
                mkBullet("b9", "Built a game in Rust", ["rust", "game"]),
            ],
            metrics: null,
            githubRepo: null,
            portfolio: false,
            metricsUpdatedAt: null,
            position: 1,
            createdAt: now,
            updatedAt: now,
        },
    ],
    education: [
        {
            id: "ed1",
            profileId: "p1",
            institution: "State U",
            degree: "BS",
            field: "CS",
            startDate: "2018-01-01T00:00:00.000Z",
            endDate: "2022-01-01T00:00:00.000Z",
            bullets: [
                mkBullet("b10", "GPA 3.8, focus on systems", ["systems"]),
            ],
            position: 0,
            createdAt: now,
            updatedAt: now,
        },
    ],
    createdAt: now,
    updatedAt: now,
};

// ─── Tests ────────────────────────────────────────────────────────────────

// 1) Excluded bullets never appear, even if their tags match.
{
    const sel = selectBullets(profile, ["typescript"]);
    const all = flattenSelections(sel);
    if (all.some(s => s.bulletId === "b5")) fail("excluded bullet leaked into selection");
    else pass("excluded bullet b5 never included");
}

// 2) Locked bullets always appear, even with zero keyword overlap.
{
    const sel = selectBullets(profile, ["completely-unrelated-keyword"]);
    const all = flattenSelections(sel);
    if (!all.some(s => s.bulletId === "b4" && s.locked)) fail("locked bullet b4 missing");
    else pass("locked bullet b4 always included");
}

// 3) Tag matches score higher than substring-only matches.
{
    const sel = selectBullets(profile, ["typescript"]);
    const wr1 = sel.workRoles.find(w => w.entity.id === "wr1");
    if (!wr1) {
        fail("wr1 missing from selection");
    } else {
        // b1 has tag "typescript" → tag-weight 2. b3 has neither tag nor text match → 0.
        const b1 = wr1.bullets.find(b => b.bulletId === "b1");
        if (!b1 || b1.score < 2) fail("b1 should score >= 2 for typescript tag match", b1);
        else pass("b1 scores >= 2 for tag match");
    }
}

// 4) Substring matches inside text score even without tag match.
{
    const sel = selectBullets(profile, ["pandas"]);
    const wr1 = sel.workRoles.find(w => w.entity.id === "wr1");
    const b2 = wr1?.bullets.find(b => b.bulletId === "b2");
    if (!b2 || !b2.matchedKeywords.includes("pandas")) fail("b2 should match 'pandas' substring", b2);
    else pass("b2 substring-matches 'pandas'");
}

// 5) Most-recent work role is kept even with zero matches.
{
    const sel = selectBullets(profile, ["python"]); // wr1 has b2 (python tag) so wr1 kept anyway
    const wr1 = sel.workRoles.find(w => w.entity.id === "wr1");
    if (!wr1) fail("wr1 missing — should be kept always (recent role)");
    else pass("most-recent work role kept");
    const wr2 = sel.workRoles.find(w => w.entity.id === "wr2");
    if (wr2) fail("wr2 should be dropped (zero-score, not most-recent)");
    else pass("zero-score older work role wr2 dropped");
}

// 6) maxBullets caps honored.
{
    const sel = selectBullets(profile, ["typescript", "python", "leadership"], { maxBulletsPerWorkRole: 2 });
    const wr1 = sel.workRoles.find(w => w.entity.id === "wr1");
    if (!wr1 || wr1.bullets.length > 2) fail("maxBulletsPerWorkRole not honored", wr1?.bullets.length);
    else pass("maxBulletsPerWorkRole=2 respected");
}

// 7) Education kept even with zero matches.
{
    const sel = selectBullets(profile, ["nothing"]);
    if (!sel.education.find(e => e.entity.id === "ed1")) fail("ed1 should always be kept");
    else pass("education kept even with no matches");
}

// 8) Projects below MIN_KEEP_SCORE get dropped when dropZeroScoreEntities=true (default).
{
    const sel = selectBullets(profile, ["python"]);
    if (sel.projects.find(p => p.entity.id === "pr2")) fail("zero-score project pr2 should be dropped");
    else pass("zero-score project dropped");
}

// 8b) An entity whose top bullet matches via substring ONLY (score 1) is
// dropped — even though the keyword "hit", the entity isn't relevant enough
// to occupy resume real estate. Regression guard against the Freckle-on-
// security-resume leak (May 2026): the keyword "Security" substring-matched
// the literal word "security" inside an off-topic Postgres-migration bullet.
{
    const substringOnlyProfile: ProfileWire = {
        ...profile,
        workRoles: [
            profile.workRoles[0], // wr1 stays as the most-recent (kept-always spine)
            {
                ...profile.workRoles[1],
                id: "wr-off-topic",
                bullets: [
                    // Bullet text contains "security" but the tags are all
                    // unrelated to a security posting. Substring hit → score 1.
                    mkBullet("b-offtopic", "Improved data integrity and security on a Postgres migration", ["postgresql", "supabase"]),
                ],
            },
        ],
    };
    const sel = selectBullets(substringOnlyProfile, ["Security", "Patrol", "Incident Reporting"]);
    if (sel.workRoles.find(w => w.entity.id === "wr-off-topic")) {
        fail("off-topic substring-only entity (score 1) should be dropped under MIN_KEEP_SCORE=2");
    } else {
        pass("substring-only (score 1) off-topic work role dropped");
    }
}

// 9) Stable bullet ids preserved through selection.
{
    const sel = selectBullets(profile, ["typescript", "go"]);
    const all = flattenSelections(sel);
    const expected = new Set(["b1", "b4", "b7", "b8", "b10"]);
    for (const id of expected) {
        if (!all.find(s => s.bulletId === id)) fail(`expected bullet id ${id} in selection`, all.map(s => s.bulletId));
    }
    pass("expected bullet ids appear in selection");
}

console.log(`\n${passes}/${passes + fails} steps passed`);
if (fails > 0) process.exit(1);
console.log("All checks passed.");
