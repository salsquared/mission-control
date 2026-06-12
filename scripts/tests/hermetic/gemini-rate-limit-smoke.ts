/**
 * PC-6 hermetic smoke. Exercises the per-process FALLBACK token-bucket path of
 * lib/ai/rate-limit.ts directly (no Gemini API calls — verifies gating logic).
 *
 * Since the OQ14a rework the PRIMARY budget is the cross-process shared bucket
 * (covered by gemini-shared-bucket-smoke.ts); this smoke pins GEMINI_BUCKET_PATH
 * at an unopenable path so acquireGeminiSlot deterministically degrades to the
 * per-process bucket — which runs at HALF the shared rate, starts full, and
 * fail-fasts past the burst cap.
 *
 * Env vars must be set BEFORE the module is imported (the rate constants
 * are captured at module load), so we use a dynamic import.
 */
export {}; // make this a module so top-level `function check` doesn't collide globally
process.env.GEMINI_RATE_PER_MIN = "6"; // shared rate 6/min ⇒ fallback 3/min (1 token per 20s)
process.env.GEMINI_RATE_BURST = "3";
// Unopenable shared-bucket path ⇒ the fallback path runs, and the smoke never
// touches the real data/gemini-bucket.db.
process.env.GEMINI_BUCKET_PATH = `/nonexistent-gemini-dir-${process.pid}/b.db`;

let passed = 0;
let failed = 0;
function check(name: string, condition: boolean, detail?: string) {
    if (condition) { console.log(`[PASS] ${name}`); passed++; }
    else { console.error(`[FAIL] ${name}${detail ? ` — ${detail}` : ""}`); failed++; }
}

async function main() {
    // Dynamic import: ensures the env var override is in effect when the
    // module's top-level reads from process.env.
    const { acquireGeminiSlot, geminiBucketSnapshot, _resetGeminiBucketForTests } =
        await import("@/lib/ai/rate-limit");

    _resetGeminiBucketForTests();

    // 1. Drain the initial fallback tokens (fallbackRate = 3, starts full)
    //    without blocking.
    const t0 = Date.now();
    for (let i = 0; i < 3; i++) await acquireGeminiSlot();
    check("3 immediate acquires complete fast (<150ms)", Date.now() - t0 < 150, `took ${Date.now() - t0}ms`);

    const snap = geminiBucketSnapshot();
    check("snapshot: tokens drained to near zero", snap.tokens < 1, `tokens=${snap.tokens}`);
    check("snapshot: queue empty after draining", snap.queued === 0);
    check("snapshot: shared rate honors env override", snap.rate === 6);
    check("snapshot: fallback runs at HALF the shared rate", snap.fallbackRate === 3, `fallbackRate=${snap.fallbackRate}`);
    check("snapshot: burst honors env override", snap.burst === 3);

    // 2. Queue 3 more — at burst cap. 4th must reject.
    _resetGeminiBucketForTests();
    for (let i = 0; i < 3; i++) await acquireGeminiSlot(); // exhaust again

    const queued = [
        acquireGeminiSlot(),
        acquireGeminiSlot(),
        acquireGeminiSlot(),
    ];
    queued.forEach(p => p.then(() => undefined, () => undefined));

    let burstThrew = false;
    try {
        await acquireGeminiSlot();
    } catch (e: any) {
        if (typeof e?.message === "string" && /capacity|burst/i.test(e.message)) burstThrew = true;
        else throw e;
    }
    check("queue past burst cap throws", burstThrew);

    console.log(`\n${passed}/${passed + failed} steps passed`);
    if (failed > 0) process.exit(1);
    console.log("All checks passed.");
    process.exit(0); // bail before the queued drain timer tries to drain
}

main().catch(e => { console.error(e); process.exit(1); });
