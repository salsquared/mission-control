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
import { runStaleApplicationNudges } from './jobs/stale-applications';
import { runDeadlineNudges } from './jobs/deadline-nudges';
import { runPostingDigest } from './jobs/posting-digest';
import { runWebhookDeliveryPrune } from './jobs/webhook-delivery-prune';
import { runClassifyPendingEmploymentTypes } from './jobs/classify-pending-employment-types';
import { runGmailWatchRenew } from './jobs/gmail-watch-renew';
import { runLlmCachePrune } from './jobs/llm-cache-prune';
import { runFetcherHealthPrune } from './jobs/fetcher-health-prune';

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
    {
        name: 'classify-pending-employment-types',
        // Lockstep sweep — job-watcher only classifies inline on first-run
        // crawls; everything else waits for this consolidated pass. 4h
        // matches the careers-page default scheduleMinutes so the worst-case
        // wait for a newly-discovered posting to get a type is ~one fetch
        // cycle plus this sweep.
        intervalMs: 4 * 60 * 60 * 1000,
        run: async () => {
            const r = await runClassifyPendingEmploymentTypes();
            if (r.distinct > 0) {
                console.info(`[classify-pending-employment-types] swept ${r.distinct} distinct externalIds — ${r.classified} classified, ${r.rowsUpdated} rows updated`);
            }
        },
    },
    {
        name: 'gmail-watch-renew',
        // Daily — Gmail push-watch subscriptions expire after ~7 days, so a
        // daily re-arm is a 7x safety margin; the 10s startup stagger also
        // re-arms on every scheduler restart. Idempotent across tiers (both
        // arm the same shared topic). Per-user no-op when GMAIL_PUBSUB_TOPIC is
        // unset — see lib/gmail/watch.ts + docs/archive/gmail-realtime-push.html.
        intervalMs: 24 * 60 * 60 * 1000,
        run: async () => {
            const r = await runGmailWatchRenew();
            if (r.processed > 0) {
                console.info(`[gmail-watch-renew] ${r.renewed}/${r.processed} re-armed, ${r.failed} failed`);
            }
        },
    },
    {
        name: 'llm-cache-prune',
        // Daily — bound the shared cross-tier LLM cache (data/llm-cache.db).
        // Content-addressed keys make eviction housekeeping, not correctness
        // (a pruned entry just recomputes on next recurrence). Both tiers run
        // this against the same file; the deletes are idempotent. No-op when
        // the cache failed to init on this tier (best-effort). See
        // docs/archive/cross-tier-llm-dedup.html.
        intervalMs: 24 * 60 * 60 * 1000,
        run: async () => {
            const r = await runLlmCachePrune();
            if (r.deleted > 0) {
                console.info(`[llm-cache-prune] deleted ${r.deleted} rows (done<${r.doneCutoff.toISOString()}, pending<${r.pendingCutoff.toISOString()})`);
            }
        },
    },
    {
        name: 'fetcher-health-prune',
        // Daily — bound the per-tier fetcher-health store (data/fetcher-health.db)
        // to 48h. The card only queries 24h, so this is pure housekeeping; no
        // roll-up job is needed (the route aggregates raw events on read). No-op
        // when the store failed to init on this tier (best-effort). See
        // docs/fetcher-health-store.html.
        intervalMs: 24 * 60 * 60 * 1000,
        run: async () => {
            const r = await runFetcherHealthPrune();
            if (r.deleted > 0) {
                console.info(`[fetcher-health-prune] deleted ${r.deleted} rows (older than ${r.cutoff.toISOString()})`);
            }
        },
    },
    // Future: weekly-paper-pick (Mon 09:00).
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

for (const [i, job] of JOBS.entries()) {
    const tick = async () => {
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
    };
    // Kick once at startup, staggered by 10s per job so a fresh boot doesn't
    // all-fire at once. setInterval otherwise waits `intervalMs` BEFORE the
    // first invocation — daily jobs (stale-applications, deadline-nudges,
    // posting-digest) would sit idle for 24h after every scheduler restart,
    // and a flapping process never gets to dispatch anything. Cooldown /
    // dedup keys on each job's dispatch path make duplicate startup runs
    // (rapid restart) idempotent.
    setTimeout(tick, 10_000 * (i + 1));
    setInterval(tick, job.intervalMs);
}

const shutdown = (signal: string) => {
    console.info(`${TAG} ${signal} received, exiting`);
    process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

console.info(`${TAG} ready`);
