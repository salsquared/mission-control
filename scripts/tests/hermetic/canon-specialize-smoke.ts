// Hermetic smoke for the specialization-pass selection reconstruction
// (docs/canonical-resumes.html §6 Q5 / §7 P5). reconstructSelection rebuilds
// the nested ResumeSelection from a canon resume's stored FLAT selections +
// profileSnapshot, preserving the canon's exact bullet set + order (only
// wording is re-done downstream). Pure — no DB, no LLM.
//   npx tsx scripts/tests/hermetic/canon-specialize-smoke.ts

import { reconstructSelection, type StoredSelectionRow, type MatchOverride } from "@/lib/canons/specialize";
import { flattenSelections } from "@/lib/resumes/select";
import type { ProfileWire } from "@/lib/schemas/profile";

let passes = 0;
let fails = 0;
function ok(msg: string, cond: boolean) {
    if (cond) { console.log(`[PASS] ${msg}`); passes++; }
    else { console.error(`[FAIL] ${msg}`); fails++; }
}

// Minimal profile — reconstructSelection only reads entity.id and stores the
// entity object, so a cast keeps the fixture small.
const profile = {
    workRoles: [{ id: "wr1" }, { id: "wr2" }],
    projects: [{ id: "pr1" }],
    education: [{ id: "ed1" }],
} as unknown as ProfileWire;

const stored: StoredSelectionRow[] = [
    { kind: "workRole", sourceId: "wr1", sourceLabel: "WR1", bulletId: "b1", originalText: "did x", locked: false },
    { kind: "workRole", sourceId: "wr1", sourceLabel: "WR1", bulletId: "b2", originalText: "synth y", synthSource: "scratchpad" },
    { kind: "workRole", sourceId: "wr2", sourceLabel: "WR2", bulletId: "b3", originalText: "did z" },
    { kind: "project", sourceId: "pr1", sourceLabel: "PR1", bulletId: "b4", originalText: "built q" },
    { kind: "education", sourceId: "ed1", sourceLabel: "ED1", bulletId: "b5", originalText: "studied" },
    // Entity deleted from the profile since canon gen — must be dropped.
    { kind: "workRole", sourceId: "wrGONE", sourceLabel: "gone", bulletId: "b6", originalText: "orphan" },
];

const matches: MatchOverride = new Map([["b1", { matchedTags: ["security"], matchedKeywords: ["patrol"] }]]);

const sel = reconstructSelection(stored, profile, matches);
const flat = flattenSelections(sel);

ok("workRoles: 2 surviving entities (orphan dropped)", sel.workRoles.length === 2);
ok("workRoles: order preserved (wr1, wr2)", sel.workRoles[0]?.entity.id === "wr1" && sel.workRoles[1]?.entity.id === "wr2");
ok("wr1: bullets b1,b2 in order", sel.workRoles[0]?.bullets.map((b) => b.bulletId).join(",") === "b1,b2");
ok("synthSource preserved on b2", sel.workRoles[0]?.bullets[1]?.synthSource === "scratchpad");
ok("projects: 1 entity (pr1)", sel.projects.length === 1 && sel.projects[0]?.entity.id === "pr1");
ok("education: 1 entity (ed1)", sel.education.length === 1 && sel.education[0]?.entity.id === "ed1");

const flatIds = flat.map((b) => b.bulletId).sort().join(",");
ok("flat bullet set == stored minus orphan", flatIds === "b1,b2,b3,b4,b5");
ok("orphan bullet b6 excluded", !flat.some((b) => b.bulletId === "b6"));

const b1 = flat.find((b) => b.bulletId === "b1");
ok("match override applied to b1", b1?.matchedTags.join() === "security" && b1?.matchedKeywords.join() === "patrol");
const b3 = flat.find((b) => b.bulletId === "b3");
ok("no override → empty matches (rewrite passes through)", b3?.matchedTags.length === 0 && b3?.matchedKeywords.length === 0);

console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails === 0 ? 0 : 1);
