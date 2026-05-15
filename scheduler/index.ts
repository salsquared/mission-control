// mission-control-scheduler — long-lived Node process owning all non-financial
// recurring work (cache pruning today; weekly paper picks, notification digest,
// fetcher health rollups planned). Pulsar owns financial fetches; this process
// must stay narrow on the same principle (see docs/mvp2_implementation.md §E2).
//
// Run via PM2: `pm2 start node_modules/.bin/tsx --name mission-control-scheduler -- scheduler/index.ts`.

import { runCachePrune } from './jobs/cache-prune';
import { runDueWatchlists } from './jobs/job-watcher';
import { runGithubMetrics } from './jobs/github-metrics';
import { runStaleApplicationNudges } from './jobs/stale-applications';

interface IntervalJob {
    name: string;
    intervalMs: number;
    run: () => Promise<void>;
}

const JOBS: IntervalJob[] = [
    { name: 'cache-prune', intervalMs: 5 * 60 * 1000, run: runCachePrune },
    {
        name: 'job-watcher',
        intervalMs: 10 * 60 * 1000,
        run: async () => {
            const result = await runDueWatchlists();
            if (result.processed > 0) {
                const totals = result.results.reduce(
                    (acc, r) => ({
                        new: acc.new + r.newPostings,
                        seen: acc.seen + r.seenAgain,
                        closed: acc.closed + r.closed,
                        errs: acc.errs + (r.error ? 1 : 0),
                    }),
                    { new: 0, seen: 0, closed: 0, errs: 0 },
                );
                console.info(`[job-watcher] processed ${result.processed} watchlists — ${totals.new} new, ${totals.seen} seen-again, ${totals.closed} closed, ${totals.errs} errored`);
            }
        },
    },
    {
        name: 'github-metrics',
        intervalMs: 6 * 60 * 60 * 1000, // 6h — combined with the 20h freshness gate inside the job, effectively daily-ish per portfolio project
        run: async () => {
            const r = await runGithubMetrics();
            if (r.processed > 0) {
                console.info(`[github-metrics] processed ${r.processed} — ${r.succeeded} succeeded, ${r.failed} failed, ${r.skippedRecent} skipped (recent)`);
            }
        },
    },
    {
        name: 'stale-applications',
        intervalMs: 24 * 60 * 60 * 1000, // daily — nudge dedup is on the helper side
        run: async () => {
            const r = await runStaleApplicationNudges();
            if (r.processed > 0) {
                console.info(`[stale-applications] processed ${r.processed} stale apps — ${r.nudged} nudged, ${r.skippedCooldown} cooled-down`);
            }
        },
    },
    // Future: weekly-paper-pick (Mon 09:00), notification-digest (08:00 daily),
    // fetcher-health-roll (1 min). Add cron-based scheduling when the first
    // cron job lands.
];

console.info(`[SCHEDULER] starting with ${JOBS.length} job(s): ${JOBS.map(j => j.name).join(', ')}`);

for (const job of JOBS) {
    setInterval(async () => {
        try {
            console.info(`[SCHEDULER] running ${job.name}`);
            await job.run();
        } catch (e) {
            console.error(`[SCHEDULER] ${job.name} failed:`, e);
        }
    }, job.intervalMs);
}

const shutdown = (signal: string) => {
    console.info(`[SCHEDULER] ${signal} received, exiting`);
    process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

console.info('[SCHEDULER] ready');
