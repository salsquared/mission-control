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
import { WatchlistConfigSchema } from "@/lib/schemas/watchlists";
import { broadcastEvent } from "@/lib/events";

export interface RunResult {
    watchlistId: string;
    newPostings: number;
    seenAgain: number;
    error: string | null;
}

function externalIdFor(company: string, title: string, sourceUrl: string): string {
    const h = createHash("sha256");
    h.update(`${company}|${title}|${sourceUrl}`);
    return h.digest("hex");
}

async function processOne(watchlistId: string, opts?: { broadcast?: boolean }): Promise<RunResult> {
    const broadcast = opts?.broadcast ?? false;
    const watchlist = await prisma.watchlist.findUnique({ where: { id: watchlistId } });
    if (!watchlist) return { watchlistId, newPostings: 0, seenAgain: 0, error: "watchlist not found" };
    if (!watchlist.active) return { watchlistId, newPostings: 0, seenAgain: 0, error: "watchlist is paused" };

    let config: ReturnType<typeof WatchlistConfigSchema.parse>;
    try {
        const parsed = JSON.parse(watchlist.config);
        config = WatchlistConfigSchema.parse(parsed);
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await prisma.watchlist.update({
            where: { id: watchlistId },
            data: { lastRunAt: new Date(), lastError: `invalid config: ${msg}` },
        });
        return { watchlistId, newPostings: 0, seenAgain: 0, error: `invalid config: ${msg}` };
    }

    if (config.kind !== watchlist.kind) {
        // Defensive — schema migration could leave them out of sync
        const msg = `kind mismatch (row=${watchlist.kind}, config=${config.kind})`;
        await prisma.watchlist.update({
            where: { id: watchlistId },
            data: { lastRunAt: new Date(), lastError: msg },
        });
        return { watchlistId, newPostings: 0, seenAgain: 0, error: msg };
    }

    const fetchResult = config.kind === "greenhouse"
        ? await fetchGreenhouse(config)
        : await fetchCareersPage(config);
    const runAt = new Date();

    if (!fetchResult.ok) {
        await prisma.watchlist.update({
            where: { id: watchlistId },
            data: { lastRunAt: runAt, lastError: fetchResult.error },
        });
        return { watchlistId, newPostings: 0, seenAgain: 0, error: fetchResult.error };
    }

    let newPostings = 0;
    let seenAgain = 0;

    // First-run sanity: if a watchlist has never been crawled before AND a single
    // pull returns more than this many postings, we still record them all (so the
    // feed is complete) but skip per-posting Notification creation to avoid
    // burying the user under 400 unread items. The user can still see them in
    // the feed; just no notification spam.
    const FIRST_RUN_NOTIFY_LIMIT = 20;
    const isFirstRun = watchlist.lastSuccessAt === null;
    const willNotifyForNew = !isFirstRun || fetchResult.postings.length <= FIRST_RUN_NOTIFY_LIMIT;

    for (const raw of fetchResult.postings) {
        const externalId = externalIdFor(raw.company, raw.title, raw.sourceUrl);
        const existing = await prisma.jobPosting.findUnique({
            where: { watchlistId_externalId: { watchlistId, externalId } },
            select: { id: true },
        });
        if (existing) {
            await prisma.jobPosting.update({
                where: { id: existing.id },
                data: { lastSeenAt: runAt },
            });
            seenAgain++;
        } else {
            const created = await prisma.jobPosting.create({
                data: {
                    watchlistId,
                    externalId,
                    company: raw.company,
                    title: raw.title,
                    location: raw.location,
                    snippet: raw.snippet,
                    sourceUrl: raw.sourceUrl,
                    status: "new",
                    firstSeenAt: runAt,
                    lastSeenAt: runAt,
                    raw: JSON.stringify(raw),
                },
            });
            if (willNotifyForNew) {
                await prisma.notification.create({
                    data: {
                        userId: watchlist.userId,
                        kind: "posting",
                        title: `${raw.company} — ${raw.title}`,
                        body: raw.location ?? null,
                        payload: JSON.stringify({ postingId: created.id, watchlistId, sourceUrl: raw.sourceUrl }),
                        channels: "in_app",
                    },
                });
            }
            newPostings++;
        }
    }

    await prisma.watchlist.update({
        where: { id: watchlistId },
        data: { lastRunAt: runAt, lastSuccessAt: runAt, lastError: null },
    });

    // First-run digest: when we suppressed per-posting notifications, drop a
    // single summary one so the user still sees the watchlist did something.
    if (isFirstRun && !willNotifyForNew && newPostings > 0) {
        await prisma.notification.create({
            data: {
                userId: watchlist.userId,
                kind: "system",
                title: `${watchlist.name} — ${newPostings} postings found on first crawl`,
                body: `Open the watchlist to browse them — per-posting notifications kick in for new postings going forward.`,
                payload: JSON.stringify({ watchlistId, newPostings }),
                channels: "in_app",
            },
        });
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

    return { watchlistId, newPostings, seenAgain, error: null };
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
            results.push({ watchlistId: c.id, newPostings: 0, seenAgain: 0, error: msg });
        }
    }
    return { processed: due.length, results };
}
