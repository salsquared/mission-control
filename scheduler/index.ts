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
// surfacing the migration gap on startup. That behavior — plus an overlap
// guard that skips a tick while the previous one is still running — lives in
// wrapJob() (./wrap-job.ts), applied uniformly to every JOBS entry below (P5.1).

import { runCachePrune } from './jobs/cache-prune';
import { runDueWatchlists, reconcileClosedPostingCascade } from './jobs/job-watcher';
import { runStaleApplicationNudges } from './jobs/stale-applications';
import { runDeadlineNudges } from './jobs/deadline-nudges';
import { runPostingDigest } from './jobs/posting-digest';
import { runWebhookDeliveryPrune } from './jobs/webhook-delivery-prune';
import { runClassifyPendingEmploymentTypes } from './jobs/classify-pending-employment-types';
import { runGmailWatchRenew } from './jobs/gmail-watch-renew';
import { runLlmCachePrune } from './jobs/llm-cache-prune';
import { runFetcherHealthPrune } from './jobs/fetcher-health-prune';
import { runLogsPrune } from './jobs/logs-prune';
import { initLogger, subscribeToLogs } from '@/lib/logger';
import { recordLogLine } from '@/lib/logs-store';
import { wrapJob } from './wrap-job';

// Give the scheduler the same structured logger the web runtime gets from
// instrumentation.ts: JSON {ts,level,msg,source,tier} stdout lines + the ring
// buffer / listener fan-out that lib/logs-store.ts drains into data/logs.db for
// the in-app viewer. ONLY the logger patch — NOT the rest of register(), which
// is web-only (Lunary, the Pulsar WS relay, shutdown drains). Called before any
// console.* below so every scheduler line is structured + source-tagged.
// See docs/archive/scheduler-structured-logs.html.
initLogger();

// Scheduler-only sink (OQ8): drain every structured log line into the shared
// per-tier data/logs.db so the web tier's in-app viewer can tail + show them.
// The web process never writes here — it only reads. Best-effort: a store-init
// failure degrades to a silent no-op. See lib/logs-store.ts.
subscribeToLogs(recordLogLine);

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
            // P5.1 reconcile sweep — top-of-run, before the crawl pass:
            // INTERESTED cards whose linked posting is already closed but
            // whose Pillar C → A cascade was missed (process died mid-
            // cascade, cascade threw and was warn-swallowed) self-heal
            // within one tick. Idempotent — the second pass finds nothing.
            // Best-effort EXCEPT P2021 (schema-behind tier), which must
            // propagate so wrapJob disables the whole job once, loudly,
            // instead of this warn firing every tick.
            try {
                await reconcileClosedPostingCascade();
            } catch (e) {
                if ((e as { code?: string } | null)?.code === 'P2021') throw e;
                console.warn('[job-watcher] reconcile sweep failed — continuing with crawl:', e);
            }
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
            // Cold-boot resilience: PM2's boot LaunchDaemon
            // (/Library/LaunchDaemons/pm2.sal.plist) can resurrect this
            // scheduler before the network/DNS is ready, so the startup re-arm
            // fails with ENOTFOUND and real-time Gmail push then sits dark until
            // the next daily tick (~24h). Retry with backoff while a failure
            // still looks like a transient network fault — register is
            // idempotent (re-arming an already-armed mailbox is a no-op), and a
            // non-network failure (e.g. revoked token) leaves networkFailures at
            // 0 so we fall through immediately instead of looping.
            const RETRY_BACKOFFS_MS = [15_000, 45_000, 120_000, 300_000];
            let r = await runGmailWatchRenew();
            for (let i = 0; r.networkFailures > 0 && i < RETRY_BACKOFFS_MS.length; i++) {
                console.warn(`[gmail-watch-renew] ${r.networkFailures} transient network failure(s) — retry ${i + 1}/${RETRY_BACKOFFS_MS.length} in ${RETRY_BACKOFFS_MS[i] / 1000}s`);
                await new Promise((res) => setTimeout(res, RETRY_BACKOFFS_MS[i]));
                r = await runGmailWatchRenew();
            }
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
        // docs/archive/fetcher-health-store.html.
        intervalMs: 24 * 60 * 60 * 1000,
        run: async () => {
            const r = await runFetcherHealthPrune();
            if (r.deleted > 0) {
                console.info(`[fetcher-health-prune] deleted ${r.deleted} rows (older than ${r.cutoff.toISOString()})`);
            }
        },
    },
    {
        name: 'logs-prune',
        // Daily — bound the scheduler-log bridge store (data/logs.db) to 48h.
        // The in-app viewer only queries ~24h, so this is pure housekeeping; no
        // roll-up needed (the routes read raw rows). No-op when the store failed
        // to init on this tier (best-effort). See docs/archive/scheduler-structured-logs.html.
        intervalMs: 24 * 60 * 60 * 1000,
        run: async () => {
            const r = await runLogsPrune();
            if (r.deleted > 0) {
                console.info(`[logs-prune] deleted ${r.deleted} rows (older than ${r.cutoff.toISOString()})`);
            }
        },
    },
    // Future: weekly-paper-pick (Mon 09:00).
    // Add cron-based scheduling when the first cron job lands.
];

const TIER = process.env.MC_SCHEDULER_TIER ?? 'default';
const TAG = `[SCHEDULER:${TIER}]`;

console.info(`${TAG} starting with ${JOBS.length} job(s): ${JOBS.map(j => j.name).join(', ')}`);

for (const [i, job] of JOBS.entries()) {
    // P5.1 — wrapJob consolidates the per-tick concerns for every job:
    // overlap guard (skip + warn while the previous tick is still running),
    // one-shot P2021 disable (schema-behind tier), and catch-all error
    // logging. See ./wrap-job.ts.
    const tick = wrapJob({ name: job.name, run: job.run, tag: TAG });
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
