/**
 * Live smoke for the Tier-B employment-type classifier (lib/ai/classify-employment-type.ts).
 *
 * Hits Gemini Flash with a curated fixture of ambiguous postings — the kind
 * the title heuristic in lib/fetchers/employment-type.ts returns null on —
 * and prints both the per-batch + overall timing AND each posting's verdict.
 *
 * Run on demand; DO NOT wire into pre-push (real network, costs tokens):
 *
 *   npx tsx scripts/tests/employment-type-classifier-live.ts
 *
 * Exit codes: 0 on success, 1 if any expected-classification check fails,
 * 2 on hard error.
 *
 * Reference for the "is this fast enough?" decision the user flagged: a single
 * 50-item batch should land under ~5s on Gemini Flash. If we see ten-second+
 * batches consistently we should consider the local Gemma-3n path on the mac
 * mini (the call shape in classify-employment-type.ts is thin enough to swap
 * the chatJSON helper for a local one without touching the caller).
 */
import { classifyEmploymentTypes, type ClassifyInput } from "@/lib/ai/classify-employment-type";

interface Fixture extends ClassifyInput {
    /** What we'd expect a reasonable model to return. null = ambiguous-on-purpose. */
    expect: "full-time" | "part-time" | "internship" | "contract" | "temporary" | null;
    /** If true, the test is strict — failing it bumps the exit code. Otherwise informational. */
    strict?: boolean;
}

const FIXTURES: Fixture[] = [
    // Generic permanent-role titles — should default to full-time.
    { id: "fx-1", company: "Anthropic", title: "Software Engineer", snippet: "Engineering", location: "San Francisco, CA", expect: "full-time", strict: true },
    { id: "fx-2", company: "Stripe", title: "Senior Backend Engineer", snippet: "Payments Infrastructure", location: "Remote, US", expect: "full-time", strict: true },
    { id: "fx-3", company: "Datadog", title: "Staff Site Reliability Engineer", snippet: "Platform", location: "New York, NY", expect: "full-time", strict: true },

    // Internship-class roles without "intern" in the title.
    { id: "fx-4", company: "Anthropic", title: "AI Safety Fellow", snippet: "Research, Fellows Program", location: "London, UK", expect: "internship", strict: true },
    { id: "fx-5", company: "OpenAI", title: "Residency Program — Applied Research", snippet: "Residency", location: "San Francisco, CA", expect: "internship", strict: false },

    // Contract-administering permanent roles — must NOT classify as contract.
    { id: "fx-6", company: "Boeing", title: "Vendor and Contract Manager", snippet: "Procurement", location: "Seattle, WA", expect: "full-time", strict: true },
    { id: "fx-7", company: "Blue Origin", title: "Contract Negotiator III", snippet: "Supply Chain", location: "Kent, WA", expect: "full-time", strict: true },

    // Genuinely-contract roles.
    { id: "fx-8", company: "Linear", title: "Freelance Brand Designer", snippet: "Design", location: "Remote", expect: "contract", strict: true },

    // Part-time / temporary.
    { id: "fx-9", company: "Reddit", title: "Community Moderator (Part-time)", snippet: "Community", location: "Remote", expect: "part-time", strict: true },
    { id: "fx-10", company: "Planet", title: "Seasonal Imagery QA Reviewer", snippet: "Operations", location: "San Francisco, CA", expect: "temporary", strict: false },

    // Ambiguous — we'd accept null OR full-time without failing.
    { id: "fx-11", company: "Recursion", title: "Lab Operations Associate", snippet: "Wet Lab", location: "Salt Lake City, UT", expect: null, strict: false },
];

let passed = 0;
let failed = 0;
const informational: { id: string; title: string; expected: string; got: string }[] = [];

async function main() {
    if (!process.env.GOOGLE_GENERATIVE_AI_KEY && !process.env.GEMINI_API_KEY && !process.env.GOOGLE_GEN_AI_KEY && !process.env.GOOGLE_API_KEY) {
        console.error("[FAIL] No Google GenAI key. Set GOOGLE_GENERATIVE_AI_KEY in .env (or export it for this run).");
        process.exit(2);
    }

    console.log(`Classifying ${FIXTURES.length} fixtures…\n`);
    const wallStart = Date.now();
    const result = await classifyEmploymentTypes(FIXTURES);
    const wallElapsed = Date.now() - wallStart;
    console.log(""); // spacer after the [employment-type-classifier] log lines

    for (const fx of FIXTURES) {
        const got = result.get(fx.id);
        const gotStr = got === null ? "null" : got ?? "UNKNOWN";
        const expectedStr = fx.expect === null ? "null" : fx.expect;
        const ok = got === fx.expect;
        if (fx.strict) {
            if (ok) {
                console.log(`[PASS] ${fx.id} "${fx.title}" → ${gotStr}`);
                passed++;
            } else {
                console.error(`[FAIL] ${fx.id} "${fx.title}" — expected ${expectedStr}, got ${gotStr}`);
                failed++;
            }
        } else {
            console.log(`[INFO] ${fx.id} "${fx.title}" → ${gotStr} (would've accepted ${expectedStr})`);
            if (!ok) informational.push({ id: fx.id, title: fx.title, expected: expectedStr, got: gotStr });
        }
    }

    console.log(`\nTotal wall time: ${wallElapsed}ms (${Math.round(wallElapsed / FIXTURES.length)}ms/item)`);
    console.log(`Strict: ${passed}/${passed + failed} passed`);
    if (informational.length > 0) {
        console.log(`Informational disagreements: ${informational.length}`);
        for (const i of informational) console.log(`  - ${i.id} expected ${i.expected}, got ${i.got}`);
    }

    if (wallElapsed > 15_000) {
        console.warn(`\n[WARN] Total wall time exceeded 15s — consider swapping to a local model (Gemma-3n on the mac mini). The chatJSON call shape in lib/ai/classify-employment-type.ts:classifyOneBatch is the swap point.`);
    }

    process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(2); });
