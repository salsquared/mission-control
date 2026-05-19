/**
 * PC-6 hermetic smoke. Exercises the token-bucket rate limiter directly.
 * No Gemini API calls — verifies the gating logic.
 *
 * Env vars must be set BEFORE the module is imported (the rate constants
 * are captured at module load), so we use a dynamic import.
 */
export {}; // make this a module so top-level `function check` doesn't collide globally
process.env.GEMINI_RATE_PER_MIN = "6"; // 1 token per 10s
process.env.GEMINI_RATE_BURST = "3";

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

    // 1. Drain the initial 6 tokens without blocking.
    const t0 = Date.now();
    for (let i = 0; i < 6; i++) await acquireGeminiSlot();
    check("6 immediate acquires complete fast (<100ms)", Date.now() - t0 < 100, `took ${Date.now() - t0}ms`);

    const snap = geminiBucketSnapshot();
    check("snapshot: tokens drained to near zero", snap.tokens < 1, `tokens=${snap.tokens}`);
    check("snapshot: queue empty after draining", snap.queued === 0);
    check("snapshot: rate honors env override", snap.rate === 6);
    check("snapshot: burst honors env override", snap.burst === 3);

    // 2. Queue 3 more — at burst cap. 4th must reject.
    _resetGeminiBucketForTests();
    for (let i = 0; i < 6; i++) await acquireGeminiSlot(); // exhaust again

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
    process.exit(0); // bail before the queued setTimeouts try to drain
}

main().catch(e => { console.error(e); process.exit(1); });
