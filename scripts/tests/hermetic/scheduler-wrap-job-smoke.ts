/**
 * Hermetic smoke for scheduler/wrap-job.ts:wrapJob (P5.1).
 *
 *   npx tsx scripts/tests/hermetic/scheduler-wrap-job-smoke.ts
 *
 * No DB, no network, no PM2, no real timers — the job bodies are controllable
 * deferreds, so the overlap guard is exercised by simply not awaiting the
 * first tick before firing the second. wrapJob lives in its own module
 * (deliberately NOT scheduler/index.ts, which registers real setInterval
 * timers at import) precisely so this smoke can import it in isolation.
 *
 * Asserts:
 *   - overlap guard: a tick fired while the previous one is in flight is
 *     skipped (job body NOT re-entered) with one structured warn naming the
 *     job; once the in-flight tick settles, the next tick runs normally.
 *   - P2021 disable: the first P2021 logs ONE warn (naming the missing
 *     table) and disables the job for the wrapper's lifetime — later ticks
 *     are silent no-ops (no run, no extra warn).
 *   - generic errors: logged via console.error, job NOT disabled, the
 *     `running` latch is released so the next tick re-runs.
 *   - the per-tick "running <name>" info line fires only for ticks that
 *     actually execute the body.
 */
import { wrapJob } from "@/scheduler/wrap-job";

let passes = 0;
let fails = 0;
function pass(msg: string) { realLog(`[PASS] ${msg}`); passes++; }
function fail(msg: string, detail?: unknown) { realError(`[FAIL] ${msg}`, detail ?? ""); fails++; }

// Capture console output WITHOUT suppressing it (the suite's own PASS/FAIL
// lines go through the saved originals).
const realLog = console.log.bind(console);
const realError = console.error.bind(console);
const captured: { level: "info" | "warn" | "error"; line: string }[] = [];
const origInfo = console.info;
const origWarn = console.warn;
const origError = console.error;
console.info = (...args: unknown[]) => { captured.push({ level: "info", line: args.map(String).join(" ") }); };
console.warn = (...args: unknown[]) => { captured.push({ level: "warn", line: args.map(String).join(" ") }); };
console.error = (...args: unknown[]) => { captured.push({ level: "error", line: args.map(String).join(" ") }); };
function capturedLines(level: "info" | "warn" | "error", needle: string): number {
    return captured.filter(c => c.level === level && c.line.includes(needle)).length;
}

const TAG = "[SCHEDULER:smoke]";

async function main() {
    // ─── Overlap guard ───
    {
        let calls = 0;
        let release!: () => void;
        const gate = new Promise<void>(r => { release = r; });
        const tick = wrapJob({ name: "overlap-job", tag: TAG, run: async () => { calls++; await gate; } });

        const first = tick();   // enters the body, parks on the gate
        const second = tick();  // previous tick still running → must skip
        await second;
        if (calls !== 1) fail(`overlap: body entered ${calls}x while first tick in flight, expected 1`);
        else pass("overlap: concurrent tick did not re-enter the job body");
        const skips = capturedLines("warn", "skipping overlap-job tick");
        if (skips !== 1) fail(`overlap: expected 1 skip warn naming the job, got ${skips}`);
        else pass("overlap: exactly 1 structured skip warn naming the job");

        release();
        await first;
        await tick();           // latch released → runs again
        if (calls !== 2) fail(`overlap: post-release tick ran body ${calls - 1}x more, expected 1 more`);
        else pass("overlap: next tick after the in-flight one settled runs normally");
    }

    // ─── P2021 → one warn + lifetime disable ───
    {
        let calls = 0;
        const tick = wrapJob({
            name: "p2021-job",
            tag: TAG,
            run: async () => {
                calls++;
                const e = new Error("table missing") as Error & { code: string; meta: { table: string } };
                e.code = "P2021";
                e.meta = { table: "Watchlist" };
                throw e;
            },
        });
        await tick();
        await tick();
        await tick();
        if (calls !== 1) fail(`P2021: body ran ${calls}x, expected 1 (disabled after first)`);
        else pass("P2021: job disabled after first P2021 — later ticks never run the body");
        const disables = capturedLines("warn", 'disabling p2021-job for this process — table "Watchlist" missing');
        if (disables !== 1) fail(`P2021: expected exactly 1 disable warn, got ${disables}`);
        else pass("P2021: exactly 1 loud disable warn (no per-tick spam), names the missing table");
        const runs = capturedLines("info", `${TAG} running p2021-job`);
        if (runs !== 1) fail(`P2021: expected 1 'running' info line, got ${runs} (disabled ticks must be silent)`);
        else pass("P2021: disabled ticks are fully silent (no 'running' line)");
    }

    // ─── Generic error: logged, NOT disabled, latch released ───
    {
        let calls = 0;
        const tick = wrapJob({
            name: "flaky-job",
            tag: TAG,
            run: async () => { calls++; throw new Error("boom"); },
        });
        await tick();
        await tick();
        if (calls !== 2) fail(`generic error: body ran ${calls}x across 2 ticks, expected 2 (no disable, latch released)`);
        else pass("generic error: job stays scheduled and re-runs next tick");
        const errs = capturedLines("error", `${TAG} flaky-job failed:`);
        if (errs !== 2) fail(`generic error: expected 2 error lines, got ${errs}`);
        else pass("generic error: each failure surfaced via console.error");
    }
}

main()
    .then(() => {
        console.info = origInfo;
        console.warn = origWarn;
        console.error = origError;
        console.log(`\n${passes}/${passes + fails} steps passed`);
        if (fails === 0) console.log("All checks passed.");
        if (fails > 0) process.exit(1);
    })
    .catch(e => {
        console.info = origInfo;
        console.warn = origWarn;
        console.error = origError;
        console.error("Unhandled error:", e);
        process.exit(2);
    });
