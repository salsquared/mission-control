// Hermetic smoke: the most-recent / current education is ALWAYS included
// (resume-pipeline.md). A currently-enrolled school must never be pruned in
// favor of an older, higher-scoring degree, nor demoted below it. Pure.
//   npx tsx scripts/tests/hermetic/resume-current-education-smoke.ts

import { mostRecentEducationId } from "@/lib/resumes/select";
import { getUnremovableEntityIds } from "@/lib/resumes/one-page";
import type { ResumeSelection } from "@/lib/resumes/select";
import type { EducationWire } from "@/lib/schemas/profile";

let passes = 0;
let fails = 0;
function ok(msg: string, cond: boolean) {
    if (cond) { console.log(`[PASS] ${msg}`); passes++; }
    else { console.error(`[FAIL] ${msg}`); fails++; }
}

// ─── mostRecentEducationId ranking ──────────────────────────────────────────
ok("ongoing (no endDate) beats a completed degree",
    mostRecentEducationId([{ id: "done", endDate: "2020-01-01" }, { id: "now", endDate: null }]) === "now");
ok("latest endDate among completed",
    mostRecentEducationId([{ id: "old", endDate: "2018-06-01" }, { id: "new", endDate: "2022-06-01" }]) === "new");
ok("startDate breaks ties among ongoing",
    mostRecentEducationId([{ id: "a", endDate: null, startDate: "2019-01-01" }, { id: "b", endDate: null, startDate: "2023-01-01" }]) === "b");
ok("position fallback when NO dates (Sal's CSULB case)",
    mostRecentEducationId([{ id: "csulb", position: 1 }, { id: "berkeley", position: 2 }, { id: "occ", position: 3 }]) === "csulb");
ok("empty list → null", mostRecentEducationId([]) === null);

// ─── getUnremovableEntityIds protects it even when it's NOT education[0] ─────
// Simulates the bug: the LLM relevance-reorder floated Berkeley to education[0],
// but CSULB (current, no endDate) must still be unremovable.
const edu = (id: string, position: number, endDate: string | null): { entity: EducationWire; bullets: [] } => ({
    entity: { id, position, endDate, startDate: null, institution: id } as unknown as EducationWire,
    bullets: [],
});
const selection: ResumeSelection = {
    workRoles: [],
    projects: [],
    education: [edu("berkeley", 2, "2021-06-01"), edu("csulb", 1, null)],
};
const unremovable = getUnremovableEntityIds(selection, []);
ok("current school (csulb) is unremovable even though Berkeley is education[0]", unremovable.has("csulb"));
ok("the relevance-floated Berkeley is NOT auto-protected as the education anchor", !unremovable.has("berkeley"));

console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails === 0 ? 0 : 1);
