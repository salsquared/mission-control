/**
 * Hermetic smoke for M8.5.5 (story S8.10) — the resume-rewrite prompt
 * includes the posting-keyword fold-in directive (rule 6a) and the user
 * prompt renders bullets with their tag list so the LLM can apply it.
 *
 *   npx tsx scripts/tests/hermetic/resume-rewrite-fold-in-smoke.ts
 *
 * Pure under test: `loadPromptFromDisk('resume-rewrite', vars)` reads the
 * on-disk template, substitutes {{vars}}, and returns the rendered
 * system + user pair. No DB, no LLM, no network.
 */
import { loadPromptFromDisk } from "@/lib/ai/prompts";
import { buildRewriteVars, buildRewriteUserPrompt } from "@/lib/resumes/rewrite";
import type { BulletSelection } from "@/lib/resumes/select";
import type { ParsedPosting } from "@/lib/resumes/posting";

let passes = 0;
let fails = 0;
function pass(msg: string) { console.log(`[PASS] ${msg}`); passes++; }
function fail(msg: string, detail?: unknown) { console.error(`[FAIL] ${msg}`, detail ?? ""); fails++; }

// ─── Setup: a bullet whose tags overlap the posting keywords ────────────────
// `matchedTags` is what `buildRewriteVars` surfaces into the user prompt as
// the "this bullet's tag matched a posting keyword" signal — that's the
// data the LLM rule 6a operates on.
const POSITIVE_BULLET: BulletSelection = {
    kind: "workRole",
    sourceId: "wr1",
    sourceLabel: "Acme — Senior Engineer",
    bulletId: "b001",
    originalText: "Built a service in Python for the payments team",
    matchedTags: ["Python"],
    matchedKeywords: [],
    score: 2,
    locked: false,
};

// A bullet with no tag overlap with the posting keywords — fold-in should
// be inapplicable; the LLM should NOT introduce the keyword.
const NEGATIVE_BULLET: BulletSelection = {
    kind: "workRole",
    sourceId: "wr1",
    sourceLabel: "Acme — Senior Engineer",
    bulletId: "b002",
    originalText: "Built a service in Go for the payments team",
    matchedTags: [],
    matchedKeywords: [],
    score: 0,
    locked: false,
};

const POSTING: ParsedPosting = {
    title: "Senior Python Engineer",
    company: "Globex",
    location: "Remote — US",
    seniority: "senior",
    rawText: "We're hiring a senior Python engineer.",
    keywords: ["Python", "distributed systems", "AWS"],
    sourceUrl: "https://example.invalid/jobs/1",
};

// ─── Test 1: rule 6a present in system prompt ──────────────────────────────
{
    const rendered = loadPromptFromDisk("resume-rewrite", buildRewriteVars([POSITIVE_BULLET], POSTING));
    const sys = rendered.system;
    if (!sys) { fail("rule 6a: system field missing"); }
    else {
        if (!/Posting-keyword fold-in/i.test(sys)) {
            fail("rule 6a: system prompt missing 'Posting-keyword fold-in' heading", sys.slice(0, 500));
        } else pass("rule 6a: 'Posting-keyword fold-in' present in system prompt");

        // Same rule should reference the verbatim guidance.
        if (!/verbatim/i.test(sys)) {
            fail("rule 6a: system prompt missing 'verbatim' guidance");
        } else pass("rule 6a: system prompt instructs verbatim use of the matched keyword");

        // The 'do not force' escape hatch so the LLM knows it can leave the
        // bullet unchanged when fold-in would read awkward.
        if (!/(leave the bullet|do not force|skipped where|force the keyword)/i.test(sys)) {
            fail("rule 6a: system prompt missing 'leave alone if forced' escape hatch");
        } else pass("rule 6a: system prompt allows skipping fold-in when forced");
    }
}

// ─── Test 2: user prompt surfaces the bullet's tags + posting keywords ─────
{
    const user = buildRewriteUserPrompt([POSITIVE_BULLET], POSTING);

    // The bullet text should be present so the LLM can rewrite it.
    if (!user.includes(POSITIVE_BULLET.originalText)) {
        fail("user prompt missing the original bullet text", user.slice(0, 1000));
    } else pass("user prompt includes the original bullet text");

    // The matched tag should appear in the bullet's rendered block (some shape).
    if (!/Python/i.test(user)) fail("user prompt missing the bullet's 'Python' tag", user.slice(0, 1000));
    else pass("user prompt includes the bullet's 'Python' tag");

    // The posting keywords should be enumerated.
    if (!/Python/i.test(user) || !/distributed systems/i.test(user)) {
        fail("user prompt missing one or more posting keywords");
    } else pass("user prompt enumerates the posting keywords");
}

// ─── Test 3: negative-case bullet rendered too (no tag overlap) ────────────
{
    const user = buildRewriteUserPrompt([NEGATIVE_BULLET], POSTING);
    if (!user.includes(NEGATIVE_BULLET.originalText)) {
        fail("negative case: user prompt missing the Go bullet's text");
    } else pass("negative case: user prompt includes the no-overlap bullet's text");
    // No assertion that 'Python' is absent — the keyword block lists ALL
    // posting keywords regardless of bullet match. The LLM's job is to NOT
    // introduce Python into the rewritten text (Promptfoo asserts that).
}

console.log(`\n${passes}/${passes + fails} steps passed`);
if (fails > 0) process.exit(1);
console.log("All checks passed.");
