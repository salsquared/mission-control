// mission-control-scheduler — long-lived Node process owning all non-financial
// recurring work (cache pruning today; weekly paper picks, notification digest,
// fetcher health rollups planned). Pulsar owns financial fetches; this process
// must stay narrow on the same principle (see docs/mvp2_implementation.md §E2).
//
// Run via PM2: `pm2 start node_modules/.bin/tsx --name mission-control-scheduler -- scheduler/index.ts`.

import { runCachePrune } from './jobs/cache-prune';

interface IntervalJob {
    name: string;
    intervalMs: number;
    run: () => Promise<void>;
}

const JOBS: IntervalJob[] = [
    { name: 'cache-prune', intervalMs: 5 * 60 * 1000, run: runCachePrune },
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
