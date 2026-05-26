/**
 * Hermetic smoke for skills-gap (story S8.8).
 *
 *   npx tsx scripts/tests/hermetic/skills-gap-smoke.ts
 *
 * Pure function under test — no DB, no HTTP. Exercises tag coverage,
 * substring coverage in bullet text, the `excluded` skip rule, the >=2-char
 * noise floor, dedup of repeated input keywords, case-insensitivity, and the
 * "no gap" exit path.
 */
import { computeSkillsGap } from "@/lib/resumes/skills-gap";
import type { ProfileWire } from "@/lib/schemas/profile";

let passes = 0;
let fails = 0;
function pass(msg: string) { console.log(`[PASS] ${msg}`); passes++; }
function fail(msg: string, detail?: unknown) { console.error(`[FAIL] ${msg}`, detail ?? ""); fails++; }

function mkBullet(id: string, text: string, tags: string[] = [], extra: Partial<{ locked: boolean; excluded: boolean }> = {}) {
    return { id, text, tags, autoTags: [], removedTags: [], pinnedTags: [], locked: extra.locked ?? false, excluded: extra.excluded ?? false };
}

const ISO = "2026-01-01T00:00:00.000Z";

function mkProfile(overrides: Partial<ProfileWire> = {}): ProfileWire {
    return {
        id: "p1", userId: "u1",
        headline: null, location: null, email: null, phone: null,
        links: null,
        skills: null, hobbies: null, languages: null,
        workRoles: [],
        projects: [],
        education: [],
        createdAt: ISO, updatedAt: ISO,
        ...overrides,
    };
}

function mkWorkRole(id: string, bullets: ReturnType<typeof mkBullet>[]) {
    return {
        id, profileId: "p1",
        company: `Co-${id}`, title: "Engineer",
        location: null, startDate: ISO, endDate: null,
        bullets, position: 0,
        createdAt: ISO, updatedAt: ISO,
    };
}

function eqStrArr(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

function main() {
    // ─── empty profile ───
    {
        const r = computeSkillsGap(mkProfile(), ["go", "kubernetes"]);
        if (!eqStrArr(r.missing, ["go", "kubernetes"])) fail("empty profile: every keyword missing", r);
        else pass("empty profile → every keyword missing");
        if (r.covered.length !== 0) fail("empty profile: covered should be empty");
        else pass("empty profile → covered empty");
    }

    // ─── coverage via tag ───
    {
        const p = mkProfile({
            workRoles: [mkWorkRole("w1", [mkBullet("b1", "Built APIs", ["Go", "REST"])])],
        });
        const r = computeSkillsGap(p, ["go", "kubernetes"]);
        if (!eqStrArr(r.covered, ["go"])) fail("tag coverage: 'go' should be covered", r);
        else pass("tag coverage: 'go' covered");
        if (!eqStrArr(r.missing, ["kubernetes"])) fail("tag coverage: 'kubernetes' should be missing", r);
        else pass("tag coverage: 'kubernetes' still missing");
    }

    // ─── coverage via substring in bullet text ───
    {
        const p = mkProfile({
            workRoles: [mkWorkRole("w1", [mkBullet("b1", "Deployed kubernetes clusters on AWS", [])])],
        });
        const r = computeSkillsGap(p, ["kubernetes", "terraform"]);
        if (!eqStrArr(r.covered, ["kubernetes"])) fail("text substring: 'kubernetes' covered", r);
        else pass("text substring → 'kubernetes' covered");
        if (!eqStrArr(r.missing, ["terraform"])) fail("text substring: 'terraform' missing", r);
        else pass("text substring → 'terraform' missing");
    }

    // ─── word boundaries: short keywords don't false-match inside words ───
    // Regression for the substring-false-positive bug: "ai" inside
    // "available", "go" inside "going", "ml" inside "html" must NOT count
    // as coverage.
    {
        const p = mkProfile({
            workRoles: [mkWorkRole("w1", [
                mkBullet("b1", "Available for hire; going to ship; built html templates", []),
            ])],
        });
        const r = computeSkillsGap(p, ["ai", "go", "ml"]);
        if (r.covered.length !== 0) fail("word boundaries: 'ai'/'go'/'ml' should NOT match inside 'available'/'going'/'html'", r);
        else pass("word boundaries → short kw inside larger word is not coverage");
        if (!eqStrArr(r.missing, ["ai", "go", "ml"])) fail("word boundaries: all three should be flagged missing", r);
        else pass("word boundaries → all three kw flagged missing");
    }

    // ─── word boundaries: keyword as a real word IS coverage ───
    {
        const p = mkProfile({
            workRoles: [mkWorkRole("w1", [
                mkBullet("b1", "Shipped AI features and Go services for ML pipelines", []),
            ])],
        });
        const r = computeSkillsGap(p, ["ai", "go", "ml"]);
        if (!eqStrArr(r.covered, ["ai", "go", "ml"])) fail("word boundaries: standalone words should match", r);
        else pass("word boundaries → standalone short kw matches");
    }

    // ─── special-char keywords (c++, node.js) don't blow up RegExp ───
    {
        const p = mkProfile({
            workRoles: [mkWorkRole("w1", [
                mkBullet("b1", "Built backend in c++ and Node.js services", []),
            ])],
        });
        const r = computeSkillsGap(p, ["c++", "node.js", "rust"]);
        if (!r.covered.includes("c++")) fail("c++ should be covered (substring fallback for symbol-edge kw)", r);
        else pass("c++ covered (regex-safe path for symbol-edge keywords)");
        if (!r.covered.includes("node.js")) fail("node.js should be covered", r);
        else pass("node.js covered (escaped dot, not wildcard)");
        if (!r.missing.includes("rust")) fail("rust should be missing", r);
        else pass("rust still missing when not present");
    }

    // ─── case-insensitive ───
    {
        const p = mkProfile({
            workRoles: [mkWorkRole("w1", [mkBullet("b1", "Wrote Postgres queries", ["SQL"])])],
        });
        const r = computeSkillsGap(p, ["postgres", "SQL", "redis"]);
        if (!eqStrArr(r.covered, ["postgres", "SQL"])) fail("case-insensitive: both should be covered", r);
        else pass("case-insensitive coverage works for tags and text");
        if (!eqStrArr(r.missing, ["redis"])) fail("case-insensitive: redis still missing", r);
        else pass("case-insensitive: unrelated keyword still missing");
    }

    // ─── excluded bullet does NOT contribute to coverage ───
    {
        const p = mkProfile({
            workRoles: [mkWorkRole("w1", [
                mkBullet("b1", "Built Kafka pipelines", ["Kafka"], { excluded: true }),
                mkBullet("b2", "Shipped features", []),
            ])],
        });
        const r = computeSkillsGap(p, ["kafka"]);
        if (!eqStrArr(r.missing, ["kafka"])) fail("excluded bullet shouldn't grant coverage", r);
        else pass("excluded bullet does NOT count toward coverage");
    }

    // ─── 1-char keywords filtered as noise ───
    {
        const p = mkProfile();
        const r = computeSkillsGap(p, ["a", "X", "go"]);
        if (r.missing.length !== 1 || r.missing[0] !== "go") fail("1-char keywords should be dropped", r);
        else pass("1-char keywords dropped as noise");
    }

    // ─── duplicate keywords in input deduped ───
    {
        const p = mkProfile();
        const r = computeSkillsGap(p, ["go", "Go", "GO", "rust"]);
        if (!eqStrArr(r.missing, ["go", "rust"])) fail("dup keywords should be deduped (first occurrence wins)", r);
        else pass("duplicate keywords deduped, first occurrence preserved");
    }

    // ─── all covered → empty missing ───
    {
        const p = mkProfile({
            workRoles: [mkWorkRole("w1", [
                mkBullet("b1", "Built APIs in Go and Rust", ["docker"]),
            ])],
        });
        const r = computeSkillsGap(p, ["go", "rust", "docker"]);
        if (r.missing.length !== 0) fail("all-covered: missing should be empty", r);
        else pass("all-covered → missing empty");
        if (!eqStrArr(r.covered, ["go", "rust", "docker"])) fail("all-covered: covered list off", r);
        else pass("all-covered → covered preserves input order");
    }

    // ─── coverage from projects / education entities too ───
    {
        const p = mkProfile({
            projects: [{
                id: "pr1", profileId: "p1", name: "X", description: null,
                repoUrl: null, liveUrl: null,
                bullets: [mkBullet("b1", "Server-side rendering with Next.js", [])],
                metrics: null, githubRepo: null, portfolio: false, metricsUpdatedAt: null,
                position: 0, createdAt: ISO, updatedAt: ISO,
            }],
            education: [{
                id: "e1", profileId: "p1", institution: "MIT", degree: null, field: null,
                startDate: null, endDate: null,
                bullets: [mkBullet("b1", "Coursework: distributed systems", ["distributed-systems"])],
                position: 0, createdAt: ISO, updatedAt: ISO,
            }],
        });
        const r = computeSkillsGap(p, ["next.js", "distributed-systems", "react"]);
        if (!r.covered.includes("next.js")) fail("project bullet should cover next.js", r);
        else pass("project bullets count toward coverage");
        if (!r.covered.includes("distributed-systems")) fail("education tag should cover distributed-systems", r);
        else pass("education bullets count toward coverage");
        if (!r.missing.includes("react")) fail("react should be missing", r);
        else pass("react still flagged as missing");
    }

    console.log(`\n${passes}/${passes + fails} steps passed`);
    if (fails === 0) console.log("All checks passed.");
    if (fails > 0) process.exit(1);
}

main();
