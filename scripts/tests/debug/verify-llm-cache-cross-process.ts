/**
 * Manual live verification for cross-tier LLM dedup (docs/cross-tier-llm-dedup.html).
 *
 * Proves that two SEPARATE processes (standing in for the dev + prod tiers)
 * sharing the REAL data/llm-cache.db call `compute()` only ONCE for the same
 * key — exactly the "one Gemini call across both tiers" guarantee, minus the
 * real Gemini call (a fake compute logs whether it ran).
 *
 *   npx tsx scripts/tests/debug/verify-llm-cache-cross-process.ts write   # tier A: computes + caches
 *   npx tsx scripts/tests/debug/verify-llm-cache-cross-process.ts read    # tier B: must REUSE (no compute)
 *   npx tsx scripts/tests/debug/verify-llm-cache-cross-process.ts clean   # delete the probe row
 *
 * Does NOT set LLM_CACHE_PATH, so it hits the same default path the PM2
 * processes resolve (<repo>/data/llm-cache.db) — confirming they share one file.
 */
import { llmCached } from "@/lib/ai/llm-cache";

const KEY = "PROBE:cross-process-verify:v1";
const mode = process.argv[2];

async function main() {
    if (mode === "clean") {
        const mod = await import("better-sqlite3");
        const Database = mod.default;
        const db = new Database("data/llm-cache.db");
        const res = db.prepare("DELETE FROM llm_cache WHERE key = ?").run(KEY);
        console.log(`[clean] deleted ${res.changes} probe row(s)`);
        db.close();
        return;
    }

    let computed = false;
    const result = await llmCached({ key: KEY, name: "cross-process-probe", model: "probe-model" }, async () => {
        computed = true;
        console.log(`[${mode}] >>> compute() RAN (this process produced the value)`);
        return { producedBy: mode, at: new Date().toISOString() };
    });

    console.log(`[${mode}] result =`, JSON.stringify(result), `| computedHere=${computed}`);

    if (mode === "read" && computed) {
        console.error(`[read] FAIL — tier B recomputed instead of reusing tier A's cached result. Dedup NOT working.`);
        process.exit(1);
    }
    if (mode === "read" && !computed) {
        console.log(`[read] PASS — tier B reused tier A's result with NO compute. Cross-tier dedup confirmed.`);
    }
}

main().catch((e) => {
    console.error("probe crashed:", e);
    process.exit(1);
});
