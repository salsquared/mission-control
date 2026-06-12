/**
 * Hermetic smoke for the shared cross-process Gemini rate bucket
 * (lib/ai/rate-limit.ts — OQ14a; mirrors arxiv-shared-bucket-smoke.ts).
 *
 * Fully hermetic: no network, no PM2, no Gemini API. Uses its OWN temp bucket
 * files, a synthetic clock, and `_createSharedGeminiBucketForTests` to stand up
 * TWO independent consume functions on the SAME file — i.e. two of the four
 * processes (web dev/prod + schedulers) sharing one API key.
 *
 * Scenarios:
 *   1. Burst then one paced line — the bucket starts full (RATE_PER_MIN tokens,
 *      immediate), then alternating consumes across the two handles fan out by
 *      one refill interval each (state is SHARED, not per-instance).
 *   2. Refill — after enough elapsed time a slot frees up (wait drops to 0).
 *   3. Backlog cap — once the reservation deficit exceeds GEMINI_RATE_BURST the
 *      consume throws ("backlog at capacity") instead of queueing unboundedly.
 *   4. acquireGeminiSlot uses the SHARED bucket when the file works — the
 *      per-process fallback bucket stays untouched (still full).
 *   5. Fallback at HALF rate — an unopenable path degrades acquireGeminiSlot to
 *      the per-process bucket (tokens drop there), sized at half the shared rate.
 *   6. data/gemini-bucket.db is gitignored (existing *.db glob) — git check-ignore.
 */

// RATE must be set BEFORE importing rate-limit (read once at module load).
// 60/min ⇒ a clean 1000ms refill interval for the assertions; fallback = 30/min.
process.env.GEMINI_RATE_PER_MIN = "60";
process.env.GEMINI_RATE_BURST = "5";
// Point the singleton bucket (used by acquireGeminiSlot) at our own temp file so
// scenario 4 doesn't touch the real data/gemini-bucket.db.
const TMP_SINGLETON = `/tmp/gemini-bucket-singleton-${process.pid}-${Date.now()}.db`;
process.env.GEMINI_BUCKET_PATH = TMP_SINGLETON;

import { unlinkSync } from "node:fs";
import { execSync } from "node:child_process";

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

const RATE = 60;
const INTERVAL = 1000; // 60/min
const TOL = 60;
const TMP = `/tmp/gemini-bucket-smoke-${process.pid}-${Date.now()}.db`;
const BASE = 1_700_000_000_000; // fixed synthetic "now" (ms)

async function main() {
    const {
        acquireGeminiSlot,
        geminiBucketSnapshot,
        _resetGeminiBucketForTests,
        _createSharedGeminiBucketForTests,
        _resetSharedGeminiBucketForTests,
    } = await import("@/lib/ai/rate-limit");

    try {
        // Two processes opening the SAME file.
        const procA = await _createSharedGeminiBucketForTests(TMP);
        const procB = await _createSharedGeminiBucketForTests(TMP);
        check("two processes opened the shared bucket file", procA !== null && procB !== null);
        if (!procA || !procB) throw new Error("bucket did not open");

        // ---- 1. Burst, then one paced line across both processes ---------
        // Seeded last_refill=0 ⇒ first consume caps at RATE tokens (starts full):
        // the whole burst is immediate, split across BOTH handles.
        let burstImmediate = 0;
        for (let i = 0; i < RATE; i++) {
            const w = (i % 2 === 0 ? procA : procB).consume(BASE);
            if (w === 0) burstImmediate++;
        }
        check(`burst: ${RATE} consumes (alternating handles) all immediate`, burstImmediate === RATE, `immediate=${burstImmediate}`);

        const w1 = procB.consume(BASE); // burst spent → +1 interval
        const w2 = procA.consume(BASE); // OTHER handle, same instant → +2 intervals
        check("post-burst consume waits ~1 interval", Math.abs(w1 - INTERVAL) <= TOL, `w1=${w1}`);
        check("next consume (OTHER process) waits ~2 intervals — state is shared", Math.abs(w2 - 2 * INTERVAL) <= TOL, `w2=${w2}`);

        // ---- 2. Refill frees a slot after enough elapsed -----------------
        // tokens were at -2; +5s at 60/min ⇒ +5 tokens ⇒ 3 ⇒ immediate.
        const w3 = procB.consume(BASE + 5000);
        check("refill: a slot frees after enough elapsed time", w3 === 0, `w3=${w3}`);

        // ---- 3. Backlog cap (burst=5) -------------------------------------
        // tokens now 2 at BASE+5000: expect 2 immediate, 5 reservations
        // (deficit 1..5), then deficit 6 > 5 ⇒ throw.
        let successes = 0;
        let threw: unknown = null;
        for (let i = 0; i < 20; i++) {
            try {
                procA.consume(BASE + 5000);
                successes++;
            } catch (e) {
                threw = e;
                break;
            }
        }
        check("backlog past GEMINI_RATE_BURST throws", threw instanceof Error && /backlog at capacity/.test((threw as Error).message), `threw=${threw}`);
        check("backlog cap kicks in after 2 immediate + 5 reservations", successes === 7, `successes=${successes}`);

        // ---- 4. acquireGeminiSlot uses the shared bucket when available ---
        // Singleton points at TMP_SINGLETON (a real, working file): the call
        // consumes THERE, so the per-process fallback bucket stays full.
        _resetGeminiBucketForTests();
        const t0 = Date.now();
        await acquireGeminiSlot();
        check("acquireGeminiSlot resolves immediately off a fresh shared bucket", Date.now() - t0 < 250, `took ${Date.now() - t0}ms`);
        const snapShared = geminiBucketSnapshot();
        check("shared path leaves the per-process fallback bucket untouched (full)", snapShared.tokens === snapShared.fallbackRate, `tokens=${snapShared.tokens} fallbackRate=${snapShared.fallbackRate}`);
        check("snapshot reports the SHARED configured rate", snapShared.rate === RATE, `rate=${snapShared.rate}`);

        // ---- 5. Fallback engages at HALF rate on an unopenable path -------
        const badPath = `/nonexistent-gemini-dir-${process.pid}/b.db`;
        const broken = await _createSharedGeminiBucketForTests(badPath);
        check("bad path returns null (no shared bucket)", broken === null);

        _resetSharedGeminiBucketForTests(); // drop the memoized singleton…
        process.env.GEMINI_BUCKET_PATH = badPath; // …and re-point it at the bad path
        _resetGeminiBucketForTests();
        await acquireGeminiSlot(); // must degrade to the per-process bucket
        const snapFallback = geminiBucketSnapshot();
        check("fallback engaged: per-process bucket consumed a token", Math.abs(snapFallback.tokens - (snapFallback.fallbackRate - 1)) < 0.5, `tokens=${snapFallback.tokens}`);
        check("fallback bucket is sized at HALF the shared rate", snapFallback.fallbackRate * 2 === snapFallback.rate, `fallbackRate=${snapFallback.fallbackRate} rate=${snapFallback.rate}`);

        // ---- 6. data/gemini-bucket.db is gitignored ------------------------
        let ignored = true;
        try {
            execSync("git check-ignore -q data/gemini-bucket.db", { stdio: "ignore" });
        } catch {
            ignored = false;
        }
        check("data/gemini-bucket.db is gitignored (*.db glob)", ignored);
    } finally {
        for (const suffix of ["", "-wal", "-shm"]) {
            try { unlinkSync(TMP + suffix); } catch { /* may not exist */ }
            try { unlinkSync(TMP_SINGLETON + suffix); } catch { /* may not exist */ }
        }
    }

    console.log(`\n${passed}/${passed + failed} steps passed`);
    if (failed > 0) process.exit(1);
}

main().catch((e) => {
    console.error("smoke crashed:", e);
    process.exit(1);
});
