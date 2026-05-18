/**
 * MB Phase 1 scheduler job — crawls active careers-page watchlists and
 * publishes new JobPosting rows + a Notification per new posting.
 *
 * Two entry points:
 *   - `runDueWatchlists()` — invoked by the scheduler's setInterval; iterates
 *     every active watchlist whose `lastRunAt` is older than `scheduleMinutes`.
 *   - `runWatchlist(id)` — invoked by `POST /api/watchlists/[id]/run`; processes
 *     one watchlist immediately, regardless of cadence.
 *
 * SSE broadcasts: `runWatchlist` runs in-process to the Next.js server when
 * called from the route, so `broadcastEvent` reaches connected SSE clients.
 * The scheduler process (separate from Next.js) doesn't have SSE clients;
 * UIs catch up on the next user interaction. (Phase 3 deferred work: scheduler
 * → Next.js notification webhook.)
 */
import { createHash } from "crypto";
import { prisma } from "@/lib/prisma";
import { fetchCareersPage } from "@/lib/fetchers/careers-page-fetcher";
import { fetchGreenhouse } from "@/lib/fetchers/greenhouse-fetcher";
import { fetchLever } from "@/lib/fetchers/lever-fetcher";
import { fetchAshby } from "@/lib/fetchers/ashby-fetcher";
import { fetchWorkday } from "@/lib/fetchers/workday-fetcher";
import { fetchLinkedin } from "@/lib/fetchers/linkedin-fetcher";
import { WatchlistConfigSchema } from "@/lib/schemas/watchlists";
import { hydrateWatchlistConfig } from "@/lib/watchlists/hydrate";
import { broadcastEvent } from "@/lib/events";
import { dispatchNotification } from "@/lib/notifications/dispatch";

export interface RunResult {
    watchlistId: string;
    newPostings: number;
    seenAgain: number;
    closed: number;
    error: string | null;
}

function externalIdFor(company: string, title: string, sourceUrl: string): string {
    const h = createHash("sha256");
    h.update(`${company}|${title}|${sourceUrl}`);
    return h.digest("hex");
}

// Per-watchlist in-process mutex. Prevents the findUnique→create race when a
// user double-clicks "Run now" or when a scheduler tick collides with a
// manual run. Also avoids wasted external fetch work. Survives HMR in dev by
// hanging off globalThis.
//
// Two callers of the same id share one fetch + one DB pass + one RunResult.
type RunningMap = Map<string, Promise<RunResult>>;
const g = globalThis as unknown as { __mcRunningWatchlists?: RunningMap };
if (!g.__mcRunningWatchlists) g.__mcRunningWatchlists = new Map();
const RUNNING = g.__mcRunningWatchlists;

async function processOne(watchlistId: string, opts?: { broadcast?: boolean }): Promise<RunResult> {
    // If a run is already in flight for this watchlist, return its promise.
    // Don't apply the new opts to the in-flight run — the original caller's
    // broadcast preference wins. This is fine because the result is the same
    // either way; the SSE broadcast only matters for the in-process caller.
    const inFlight = RUNNING.get(watchlistId);
    if (inFlight) return inFlight;
    const promise = processOneInner(watchlistId, opts);
    RUNNING.set(watchlistId, promise);
    try {
        return await promise;
    } finally {
        RUNNING.delete(watchlistId);
    }
}

async function processOneInner(watchlistId: string, opts?: { broadcast?: boolean }): Promise<RunResult> {
    const broadcast = opts?.broadcast ?? false;
    const watchlist = await prisma.watchlist.findUnique({ where: { id: watchlistId } });
    if (!watchlist) return { watchlistId, newPostings: 0, seenAgain: 0, closed: 0, error: "watchlist not found" };
    if (!watchlist.active) return { watchlistId, newPostings: 0, seenAgain: 0, closed: 0, error: "watchlist is paused" };

    let config: ReturnType<typeof WatchlistConfigSchema.parse>;
    try {
        // PB-14: hydrate from COMPANY_DIRECTORY when directoryKey is set, so
        // slug corrections in lib/company-directory.ts apply at next crawl
        // without re-creating the row.
        config = hydrateWatchlistConfig({ config: watchlist.config, directoryKey: watchlist.directoryKey });
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await prisma.watchlist.update({
            where: { id: watchlistId },
            data: { lastRunAt: new Date(), lastError: `invalid config: ${msg}` },
        });
        return { watchlistId, newPostings: 0, seenAgain: 0, closed: 0, error: `invalid config: ${msg}` };
    }

    if (config.kind !== watchlist.kind) {
        if (watchlist.directoryKey) {
            // PB-14: directory entry switched ATS since this row was created.
            // Trust the directory — silently update the row's `kind` so future
            // GETs / cross-checks see the live value.
            await prisma.watchlist.update({
                where: { id: watchlistId },
                data: { kind: config.kind },
            });
        } else {
            // No directory backing — defensive bail. Schema migration or
            // hand-edited config could leave them out of sync.
            const msg = `kind mismatch (row=${watchlist.kind}, config=${config.kind})`;
            await prisma.watchlist.update({
                where: { id: watchlistId },
                data: { lastRunAt: new Date(), lastError: msg },
            });
            return { watchlistId, newPostings: 0, seenAgain: 0, closed: 0, error: msg };
        }
    }

    const fetchResult = await (() => {
        switch (config.kind) {
            case "greenhouse":   return fetchGreenhouse(config);
            case "lever":        return fetchLever(config);
            case "ashby":        return fetchAshby(config);
            case "workday":      return fetchWorkday(config);
            case "linkedin":     return fetchLinkedin(config);
            case "careers-page": return fetchCareersPage(config);
        }
    })();
    const runAt = new Date();

    if (!fetchResult.ok) {
        await prisma.watchlist.update({
            where: { id: watchlistId },
            data: { lastRunAt: runAt, lastError: fetchResult.error },
        });
        return { watchlistId, newPostings: 0, seenAgain: 0, closed: 0, error: fetchResult.error };
    }

    let newPostings = 0;
    let seenAgain = 0;
    const seenExternalIds = new Set<string>();

    // First-run sanity: if a watchlist has never been crawled before AND a single
    // pull returns more than this many postings, we still record them all (so the
    // feed is complete) but skip per-posting Notification creation to avoid
    // burying the user under 400 unread items. The user can still see them in
    // the feed; just no notification spam.
    const FIRST_RUN_NOTIFY_LIMIT = 20;
    const isFirstRun = watchlist.lastSuccessAt === null;
    // Story 26 — per-watchlist notification mode gates per-posting dispatch:
    //   "each"   — fire per posting (current behavior, subject to first-run digest)
    //   "digest" — suppress; posting-digest scheduler rolls them up daily
    //   "silent" — never notify (postings still land in the feed)
    const modeAllowsPerPosting = watchlist.notificationMode === "each";
    const willNotifyForNew = modeAllowsPerPosting && (!isFirstRun || fetchResult.postings.length <= FIRST_RUN_NOTIFY_LIMIT);

    for (const raw of fetchResult.postings) {
        const externalId = externalIdFor(raw.company, raw.title, raw.sourceUrl);
        seenExternalIds.add(externalId);
        const existing = await prisma.jobPosting.findUnique({
            where: { watchlistId_externalId: { watchlistId, externalId } },
            select: { id: true },
        });
        if (existing) {
            // Always refresh lastSeenAt; also refresh employmentType so that
            // improvements to the classifier (or to the company's Greenhouse
            // metadata configuration) propagate to rows ingested before the
            // change. Cheap — same row, single UPDATE.
            await prisma.jobPosting.update({
                where: { id: existing.id },
                data: { lastSeenAt: runAt, employmentType: raw.employmentType ?? null },
            });
            seenAgain++;
            continue;
        }
        // Try to create. If a different process (scheduler vs manual run via
        // Next.js) raced us here, the unique constraint on (watchlistId,
        // externalId) throws Prisma P2002 — treat that as a lost race and
        // fall back to bumping lastSeenAt instead of erroring out the run.
        let created: { id: string } | null = null;
        try {
            created = await prisma.jobPosting.create({
                data: {
                    watchlistId,
                    externalId,
                    company: raw.company,
                    title: raw.title,
                    location: raw.location,
                    snippet: raw.snippet,
                    sourceUrl: raw.sourceUrl,
                    employmentType: raw.employmentType ?? null,
                    status: "new",
                    firstSeenAt: runAt,
                    lastSeenAt: runAt,
                    raw: JSON.stringify(raw),
                },
                select: { id: true },
            });
        } catch (e) {
            const code = (e as { code?: string } | null)?.code;
            if (code === "P2002") {
                await prisma.jobPosting.update({
                    where: { watchlistId_externalId: { watchlistId, externalId } },
                    data: { lastSeenAt: runAt, employmentType: raw.employmentType ?? null },
                });
                seenAgain++;
                continue;
            }
            throw e;
        }
        if (willNotifyForNew) {
            // Low-tier — in-app only. Posting notifications are high-volume by
            // nature; email-blasting them would be a terrible UX. The user
            // sees them in the bell + the Discovery feed.
            try {
                await dispatchNotification({
                    userId: watchlist.userId,
                    tier: "low",
                    kind: "posting",
                    title: `${raw.company} — ${raw.title}`,
                    body: raw.location ?? null,
                    payload: { postingId: created.id, watchlistId, sourceUrl: raw.sourceUrl },
                    // PB-8: one notification per posting, ever.
                    dedupKey: `posting:${created.id}`,
                });
            } catch (e) {
                console.warn(`[job-watcher] dispatchNotification failed for posting ${created.id}:`, e);
            }
        }
        newPostings++;
    }

    // Closed-posting detection (story 22). Any prior posting for this watchlist
    // that we *didn't* see in this run, that's been silent for > 6h, and that
    // isn't already terminal (closed/hidden), gets marked closed.
    //
    // SAFETY: skip when the fetch returned zero postings. An empty fetch can
    // happen for benign reasons (source temporarily blank, SPA misrender,
    // CDN hiccup) and would otherwise nuke the entire feed via `notIn: []`
    // matching every row. Better to wait for the next tick than to mass-close.
    let closed = 0;
    if (!isFirstRun && fetchResult.postings.length > 0) {
        const sixHoursAgo = new Date(runAt.getTime() - 6 * 60 * 60 * 1000);
        const closeResult = await prisma.jobPosting.updateMany({
            where: {
                watchlistId,
                status: { notIn: ["closed", "hidden"] },
                externalId: { notIn: Array.from(seenExternalIds) },
                lastSeenAt: { lt: sixHoursAgo },
            },
            data: { status: "closed", removedAt: runAt },
        });
        closed = closeResult.count;
        if (closed > 0) {
            // Standard tier — important enough to flag in the bell, but no
            // email blast. The user will see it next time they open MC.
            // PB-8: dedup on watchlist + day so a flapping source can't spam.
            await dispatchNotification({
                userId: watchlist.userId,
                tier: "standard",
                kind: "system",
                title: `${watchlist.name} — ${closed} ${closed === 1 ? "posting" : "postings"} closed`,
                body: "Removed from the source feed for more than 6 hours.",
                payload: { watchlistId, closed },
                dedupKey: `watchlist-closures:${watchlistId}:${runAt.toISOString().slice(0, 10)}`,
            }).catch(e => console.warn(`[job-watcher] closure-summary dispatch failed:`, e));
        }
    }

    await prisma.watchlist.update({
        where: { id: watchlistId },
        data: { lastRunAt: runAt, lastSuccessAt: runAt, lastError: null },
    });

    // First-run digest: when mode='each' but we suppressed per-posting
    // notifications due to volume, drop a single summary so the user still
    // sees the watchlist did something. Skipped for 'silent' (user opted out
    // entirely) and 'digest' (the daily posting-digest job will cover it).
    // Standard tier — single high-value system row, in-app only.
    if (isFirstRun && modeAllowsPerPosting && !willNotifyForNew && newPostings > 0) {
        await dispatchNotification({
            userId: watchlist.userId,
            tier: "standard",
            kind: "system",
            title: `${watchlist.name} — ${newPostings} postings found on first crawl`,
            body: `Open the watchlist to browse them — per-posting notifications kick in for new postings going forward.`,
            payload: { watchlistId, newPostings },
        }).catch(e => console.warn(`[job-watcher] first-run digest dispatch failed:`, e));
    }

    if (broadcast) {
        broadcastEvent({ model: "Watchlist", action: "upsert", id: watchlistId, timestamp: runAt.getTime() });
        if (newPostings > 0 || seenAgain > 0) {
            broadcastEvent({ model: "Posting", action: "upsert", id: watchlistId, timestamp: runAt.getTime() });
        }
        if (newPostings > 0) {
            broadcastEvent({ model: "Notification", action: "upsert", id: watchlist.userId, timestamp: runAt.getTime() });
        }
    }

    return { watchlistId, newPostings, seenAgain, closed, error: null };
}

/**
 * Manual single-watchlist trigger — called from /api/watchlists/[id]/run.
 * Broadcasts SSE because this runs in-process to the Next.js server.
 */
export async function runWatchlist(id: string): Promise<RunResult> {
    return processOne(id, { broadcast: true });
}

/**
 * Scheduler tick — invoked by setInterval in scheduler/index.ts. Loops over
 * every active watchlist whose lastRunAt is older than `scheduleMinutes`.
 * Doesn't broadcast (different process).
 */
export async function runDueWatchlists(): Promise<{ processed: number; results: RunResult[] }> {
    const now = Date.now();
    const candidates = await prisma.watchlist.findMany({
        where: { active: true },
        select: { id: true, scheduleMinutes: true, lastRunAt: true },
    });
    const due = candidates.filter(c => {
        if (!c.lastRunAt) return true;
        return now - c.lastRunAt.getTime() >= c.scheduleMinutes * 60_000;
    });
    const results: RunResult[] = [];
    for (const c of due) {
        try {
            results.push(await processOne(c.id, { broadcast: false }));
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.error(`[job-watcher] processOne(${c.id}) threw:`, e);
            results.push({ watchlistId: c.id, newPostings: 0, seenAgain: 0, closed: 0, error: msg });
        }
    }
    return { processed: due.length, results };
}
