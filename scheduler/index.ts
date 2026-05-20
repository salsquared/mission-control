// mission-control-scheduler — long-lived Node process owning all non-financial
// recurring work (cache pruning today; weekly paper picks, notification digest,
// fetcher health rollups planned). Pulsar owns financial fetches; this process
// must stay narrow on the same principle (see docs/mvp2_implementation.md §E2).
//
// Runs once per tier (dev, prod) — see ecosystem.config.cjs. MC_SCHEDULER_TIER
// is read for log prefixing only; the actual DB target comes from the env file
// PM2 loads via --env-file-if-exists (.env.development vs .env.production).
//
// A tier whose schema is behind (e.g. prod.db is missing the Watchlist table
// today) gets ONE loud warning per affected job, then the job is disabled for
// the process's lifetime. Avoids drowning logs in repeated P2021s while still
// surfacing the migration gap on startup.

import { runCachePrune } from './jobs/cache-prune';
import { runDueWatchlists } from './jobs/job-watcher';
import { runGithubMetrics } from './jobs/github-metrics';
import { runStaleApplicationNudges } from './jobs/stale-applications';
import { runDeadlineNudges } from './jobs/deadline-nudges';
import { runPostingDigest } from './jobs/posting-digest';
import { runWebhookDeliveryPrune } from './jobs/webhook-delivery-prune';

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
    {
        name: 'deadline-nudges',
        intervalMs: 24 * 60 * 60 * 1000, // daily — short cooldown (2d) keeps urgent deadlines visible
        run: async () => {
            const r = await runDeadlineNudges();
            if (r.processed > 0) {
                console.info(`[deadline-nudges] processed ${r.processed} apps with upcoming deadlines — ${r.nudged} nudged, ${r.skippedCooldown} cooled-down`);
            }
        },
    },
    {
        name: 'posting-digest',
        intervalMs: 24 * 60 * 60 * 1000, // daily — covers notificationMode='digest' watchlists
        run: async () => {
            const r = await runPostingDigest();
            if (r.processed > 0) {
                console.info(`[posting-digest] processed ${r.processed} digest watchlists — ${r.summarized} summarized, ${r.totalPostings} postings rolled up`);
            }
        },
    },
    {
        name: 'webhook-delivery-prune',
        intervalMs: 24 * 60 * 60 * 1000, // daily — PA-2 retention sweep
        run: async () => {
            const r = await runWebhookDeliveryPrune();
            if (r.deleted > 0) {
                console.info(`[webhook-delivery-prune] deleted ${r.deleted} rows older than ${r.cutoff.toISOString()}`);
            }
        },
    },
    // Future: weekly-paper-pick (Mon 09:00), fetcher-health-roll (1 min).
    // Add cron-based scheduling when the first cron job lands.
];

const TIER = process.env.MC_SCHEDULER_TIER ?? 'default';
const TAG = `[SCHEDULER:${TIER}]`;

// Jobs disabled for this process's lifetime after a P2021 (missing table).
// A schema-behind tier (e.g. un-migrated prod.db) wins one loud warning per
// affected job and then goes silent — instead of spamming the same Prisma
// error on every tick.
const disabledJobs = new Set<string>();

console.info(`${TAG} starting with ${JOBS.length} job(s): ${JOBS.map(j => j.name).join(', ')}`);

for (const job of JOBS) {
    setInterval(async () => {
        if (disabledJobs.has(job.name)) return;
        try {
            console.info(`${TAG} running ${job.name}`);
            await job.run();
        } catch (e) {
            const err = e as { code?: string; meta?: { table?: string } } | null;
            if (err?.code === 'P2021') {
                disabledJobs.add(job.name);
                const table = err?.meta?.table ?? '?';
                console.warn(`${TAG} disabling ${job.name} for this process — table "${table}" missing on this tier's DB. Run \`npx prisma migrate deploy\` against it to enable.`);
                return;
            }
            console.error(`${TAG} ${job.name} failed:`, e);
        }
    }, job.intervalMs);
}

const shutdown = (signal: string) => {
    console.info(`${TAG} ${signal} received, exiting`);
    process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

console.info(`${TAG} ready`);
