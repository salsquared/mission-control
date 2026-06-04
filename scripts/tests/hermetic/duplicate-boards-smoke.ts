/**
 * Hermetic smoke for the duplicate-board tripwire (NewPostingsCard's visible
 * "possible duplicate watchlist" flag).
 *
 *   npx tsx scripts/tests/hermetic/duplicate-boards-smoke.ts
 *
 * Pure unit test of lib/watchlists/duplicate-boards.ts:findDuplicateBoardGroups
 * — no DB, no network, no session. Locks in the detection that keeps a future
 * "Apex / Apex Space" dedup failure VISIBLE instead of silently grouped:
 *   - Same board (kind+slug), different display names → one group listing both
 *     names (the Apex/Apex Space case).
 *   - Same board, same name → still grouped (wasteful dup crawl, count ≥ 2).
 *   - Slug case-insensitivity for greenhouse → grouped.
 *   - Different slug, or same slug under a different ATS kind → NOT grouped.
 *   - linkedin / indeed / careers-page (null key) → never grouped, even when
 *     identical (their overlap is intentional).
 */

import { findDuplicateBoardGroups } from "@/lib/watchlists/duplicate-boards";
import type { WatchlistConfig } from "@/lib/schemas/watchlists";

let passes = 0;
let fails = 0;
function pass(msg: string): void { console.log(`[PASS] ${msg}`); passes++; }
function fail(msg: string, detail?: unknown): void {
    console.error(`[FAIL] ${msg}`, detail ?? "");
    fails++;
}

const gh = (boardSlug: string, companyName: string): WatchlistConfig =>
    ({ kind: "greenhouse", boardSlug, companyName });
const ashby = (boardSlug: string, companyName: string): WatchlistConfig =>
    ({ kind: "ashby", boardSlug, companyName });
const li = (keywords: string, companyName: string): WatchlistConfig =>
    ({ kind: "linkedin", keywords, companyName });

// ─── 1. The Apex/Apex Space case: same board, two names → one group ─────────
{
    const groups = findDuplicateBoardGroups([gh("apex", "Apex Space"), gh("apex", "Apex")]);
    if (groups.length !== 1) fail(`apex case: expected 1 group, got ${groups.length}`, groups);
    else if (groups[0].count !== 2) fail(`apex case: expected count 2, got ${groups[0].count}`);
    else if (JSON.stringify(groups[0].names) !== JSON.stringify(["Apex", "Apex Space"])) {
        fail(`apex case: expected sorted [Apex, Apex Space], got`, groups[0].names);
    } else {
        pass("same greenhouse board + two display names → 1 group listing both names (Apex/Apex Space)");
    }
}

// ─── 2. Same board, SAME name → still a dup (wasteful double-crawl) ─────────
{
    const groups = findDuplicateBoardGroups([gh("apex", "Apex Space"), gh("apex", "Apex Space")]);
    if (groups.length !== 1 || groups[0].count !== 2) fail("same-name dup: expected 1 group count 2", groups);
    else if (JSON.stringify(groups[0].names) !== JSON.stringify(["Apex Space"])) {
        fail("same-name dup: expected a single distinct name", groups[0].names);
    } else {
        pass("same board + identical name → still grouped (1 distinct name, count 2)");
    }
}

// ─── 3. Slug case-insensitivity for greenhouse → grouped ───────────────────
{
    const groups = findDuplicateBoardGroups([gh("apex", "Apex"), gh("APEX", "Apex Caps")]);
    if (groups.length !== 1) fail(`case-insensitive: expected 1 group, got ${groups.length}`, groups);
    else pass("greenhouse slug is case-folded → APEX and apex group together");
}

// ─── 4. Different slug → NOT grouped ───────────────────────────────────────
{
    const groups = findDuplicateBoardGroups([gh("apex", "Apex"), gh("astra", "Astra")]);
    if (groups.length !== 0) fail(`different slugs: expected 0 groups, got ${groups.length}`, groups);
    else pass("different greenhouse slugs → no false positive");
}

// ─── 5. Same slug, different ATS kind → NOT grouped ────────────────────────
{
    const groups = findDuplicateBoardGroups([gh("apex", "Apex"), ashby("apex", "Apex on Ashby")]);
    if (groups.length !== 0) fail(`cross-kind: expected 0 groups, got ${groups.length}`, groups);
    else pass("same slug under greenhouse vs ashby → not grouped (kind is part of identity)");
}

// ─── 6. Identical linkedin configs → never grouped (null key) ──────────────
{
    const groups = findDuplicateBoardGroups([li("software engineer", "LI"), li("software engineer", "LI")]);
    if (groups.length !== 0) fail(`linkedin: expected 0 groups, got ${groups.length}`, groups);
    else pass("identical linkedin keyword configs → never grouped (aggregators overlap by design)");
}

// ─── 7. Mixed corpus → only the real collision surfaces ────────────────────
{
    const groups = findDuplicateBoardGroups([
        gh("apex", "Apex Space"),
        gh("apex", "Apex"),
        ashby("apex-technology-inc", "Apex Space"), // the real Apex Space — distinct board
        gh("astra", "Astra"),
        li("intern", "LI search"),
        li("intern", "LI search"),
    ]);
    if (groups.length !== 1) fail(`mixed: expected exactly 1 group, got ${groups.length}`, groups);
    else if (groups[0].key !== "greenhouse:apex") fail(`mixed: expected key greenhouse:apex, got ${groups[0].key}`);
    else pass("mixed corpus → flags only the greenhouse:apex collision, leaves the real Ashby board + linkedin alone");
}

// ─── 8. Empty / all-unique → no groups ─────────────────────────────────────
{
    const empty = findDuplicateBoardGroups([]);
    const unique = findDuplicateBoardGroups([gh("a", "A"), gh("b", "B"), ashby("c", "C")]);
    if (empty.length !== 0 || unique.length !== 0) fail("empty/unique: expected 0 groups", { empty, unique });
    else pass("empty input and all-unique boards → no groups (no noise)");
}

console.log(`\n${passes}/${passes + fails} steps passed`);
if (fails > 0) process.exit(1);
console.log("All checks passed.");
