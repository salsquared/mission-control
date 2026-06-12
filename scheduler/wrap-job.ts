// P5.1 (codebase review 2026-06-10 §8) — ONE wrapper applied to every JOBS
// entry in scheduler/index.ts, consolidating the per-tick concerns that used
// to live ad-hoc in the registration loop there:
//
//   - Overlap guard (new): if a job's previous tick is still running (slow
//     probe round, hung upstream fetch), the new tick is SKIPPED with a
//     structured warn naming the job — instead of stacking a second
//     concurrent run of the same job in the same process. One warn per
//     skipped tick; the next interval re-checks.
//   - P2021 disable (moved from index.ts): a schema-behind tier (table
//     missing from this tier's SQLite) gets ONE loud warning, then the job
//     is disabled for the process's lifetime — instead of spamming the same
//     Prisma error every tick. Bring the lagging DB current with
//     `npx prisma migrate deploy` and restart the scheduler to re-enable.
//   - Error surfacing (moved from index.ts): any other throw is logged
//     (console.error → ring buffer / data/logs.db) and the job stays
//     scheduled — the next tick retries.
//
// Lives in its own module rather than index.ts so the hermetic smoke
// (scripts/tests/hermetic/scheduler-wrap-job-smoke.ts) can import the wrapper
// without booting the scheduler — index.ts registers real timers at import.

export interface WrapJobInput {
    /** Job name as registered in JOBS — named in every log line. */
    name: string;
    /** The job body (the JOBS entry's `run`). */
    run: () => Promise<void>;
    /** Log prefix — the documented `[SCHEDULER:<tier>]` tag from index.ts. */
    tag: string;
}

/**
 * Wrap a scheduler job body into a tick function safe to hand to
 * setTimeout/setInterval: overlap-guarded, P2021-disabling, never throws.
 */
export function wrapJob({ name, run, tag }: WrapJobInput): () => Promise<void> {
    // Per-job closure state — each JOBS entry is wrapped exactly once, so
    // this is equivalent to (and replaces) index.ts's old module-level
    // `disabledJobs` Set keyed by name.
    let running = false;
    let disabled = false;

    return async function tick(): Promise<void> {
        if (disabled) return;
        if (running) {
            console.warn(`${tag} skipping ${name} tick — previous tick still running`);
            return;
        }
        running = true;
        try {
            console.info(`${tag} running ${name}`);
            await run();
        } catch (e) {
            const err = e as { code?: string; meta?: { table?: string } } | null;
            if (err?.code === 'P2021') {
                disabled = true;
                const table = err?.meta?.table ?? '?';
                console.warn(`${tag} disabling ${name} for this process — table "${table}" missing on this tier's DB. Run \`npx prisma migrate deploy\` against it to enable.`);
                return;
            }
            console.error(`${tag} ${name} failed:`, e);
        } finally {
            running = false;
        }
    };
}
