/**
 * Hermetic smoke for the shared cross-tier arXiv rate bucket
 * (lib/arxiv/rate-limit.ts — docs/arxiv-rate-limit-fix.html Layer 3, OQ4/OQ9).
 *
 * Fully hermetic: no network, no PM2. Uses its OWN temp bucket file, a synthetic
 * clock, and `_createSharedBucketForTests` to stand up TWO independent consume
 * functions on the SAME file — i.e. the two tiers (dev + prod) sharing one IP.
 *
 * Scenarios:
 *   1. One paced line — alternating consumes across the two tiers fan out by one
 *      refill interval each (the bucket state is SHARED, not per-instance).
 *   2. Refill — after enough elapsed time a slot frees up (wait drops to 0).
 *   3. Fallback — an unwritable path returns null so acquireArxivSlot() degrades
 *      to the per-process bucket.
 */

// RATE must be set BEFORE importing rate-limit (read once at module load).
// 60/min ⇒ a clean 1000ms refill interval for the assertions.
process.env.ARXIV_RATE_PER_MIN = "60";
process.env.ARXIV_RATE_BURST = "20";

import { unlinkSync } from "node:fs";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string) {
    if (cond) {
        console.log(`[PASS] ${name}`);
        passed++;
    } else {
        console.error(`[FAIL] ${name}${detail ? ` — ${detail}` : ""}`);
        failed++;
    }
}

const INTERVAL = 1000; // 60/min
const TOL = 60;
const TMP = `/tmp/arxiv-bucket-smoke-${process.pid}-${Date.now()}.db`;
const BASE = 1_700_000_000_000; // fixed synthetic "now" (ms)

async function main() {
    const { _createSharedBucketForTests } = await import("@/lib/arxiv/rate-limit");

    try {
        // Two tiers opening the SAME file.
        const tierA = await _createSharedBucketForTests(TMP);
        const tierB = await _createSharedBucketForTests(TMP);
        check("two tiers opened the shared bucket file", tierA !== null && tierB !== null);
        if (!tierA || !tierB) throw new Error("bucket did not open");

        // ---- 1. One paced line across both tiers -------------------------
        const w1 = tierA(BASE); // first → immediate
        const w2 = tierB(BASE); // other tier, same instant → +1 interval
        const w3 = tierA(BASE); // → +2 intervals
        check("first consume is immediate", w1 === 0, `w1=${w1}`);
        check("2nd consume (OTHER tier) waits ~1 interval — state is shared", Math.abs(w2 - INTERVAL) <= TOL, `w2=${w2}`);
        check("3rd consume waits ~2 intervals (one serialized line)", Math.abs(w3 - 2 * INTERVAL) <= TOL, `w3=${w3}`);

        // ---- 2. Refill frees a slot after enough elapsed -----------------
        // tokens were at -2; +5s ⇒ +5 tokens ⇒ caps at 1 ⇒ immediate.
        const w4 = tierB(BASE + 5000);
        check("refill: a slot frees after enough elapsed time", w4 === 0, `w4=${w4}`);

        // ---- 3. Fallback on an unwritable path ---------------------------
        const broken = await _createSharedBucketForTests(`/nonexistent-arxiv-dir-${process.pid}/b.db`);
        check("bad path returns null (acquireArxivSlot falls back to per-process)", broken === null);
    } finally {
        for (const suffix of ["", "-wal", "-shm"]) {
            try { unlinkSync(TMP + suffix); } catch { /* may not exist */ }
        }
    }

    console.log(`\n${passed}/${passed + failed} steps passed`);
    if (failed > 0) process.exit(1);
}

main().catch((e) => {
    console.error("smoke crashed:", e);
    process.exit(1);
});
