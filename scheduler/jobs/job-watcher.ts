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
import { fetchSmartRecruiters } from "@/lib/fetchers/smartrecruiters-fetcher";
import { fetchWorkable } from "@/lib/fetchers/workable-fetcher";
import { fetchRecruitee } from "@/lib/fetchers/recruitee-fetcher";
import { fetchPersonio } from "@/lib/fetchers/personio-fetcher";
import { fetchClearCompany } from "@/lib/fetchers/clearcompany-fetcher";
import { fetchLinkedin } from "@/lib/fetchers/linkedin-fetcher";
import { fetchIndeed } from "@/lib/fetchers/indeed-fetcher";
import { WatchlistConfigSchema } from "@/lib/schemas/watchlists";
import { hydrateWatchlistConfig } from "@/lib/watchlists/hydrate";
import { broadcastEvent } from "@/lib/events";
import { dispatchNotification } from "@/lib/notifications/dispatch";
import { classifyEmploymentTypes } from "@/lib/ai/classify-employment-type";
import { EMPLOYMENT_TYPES, type EmploymentType } from "@/lib/fetchers/employment-type";
import {
    compileNegativeFilters,
    compileNegativeFiltersFromArray,
    matchesNegativeFilters,
} from "@/lib/postings/negative-filters";
import { findGlobalSetting, parseGlobalSetting } from "@/lib/repositories/settings";
import { parseCompensation } from "@/lib/postings/compensation";
import { probeBatch, type WatchlistKind } from "@/lib/postings/liveness";

export interface RunResult {
    watchlistId: string;
    newPostings: number;
    seenAgain: number;
    closed: number;
    /** Stale candidates that probed alive — lastSeenAt was refreshed to runAt. */
    refreshedAlive: number;
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
    if (!watchlist) return { watchlistId, newPostings: 0, seenAgain: 0, closed: 0, refreshedAlive: 0, error: "watchlist not found" };
    if (!watchlist.active) return { watchlistId, newPostings: 0, seenAgain: 0, closed: 0, refreshedAlive: 0, error: "watchlist is paused" };

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
        return { watchlistId, newPostings: 0, seenAgain: 0, closed: 0, refreshedAlive: 0, error: `invalid config: ${msg}` };
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
            return { watchlistId, newPostings: 0, seenAgain: 0, closed: 0, refreshedAlive: 0, error: msg };
        }
    }

    const fetchResult = await (() => {
        switch (config.kind) {
            case "greenhouse":      return fetchGreenhouse(config);
            case "lever":           return fetchLever(config);
            case "ashby":           return fetchAshby(config);
            case "workday":         return fetchWorkday(config);
            case "smartrecruiters": return fetchSmartRecruiters(config);
            case "workable":        return fetchWorkable(config);
            case "recruitee":       return fetchRecruitee(config);
            case "personio":        return fetchPersonio(config);
            case "clearcompany":    return fetchClearCompany(config);
            case "linkedin":        return fetchLinkedin(config);
            case "indeed":          return fetchIndeed(config);
            case "careers-page":    return fetchCareersPage(config);
        }
    })();
    const runAt = new Date();

    if (!fetchResult.ok) {
        await prisma.watchlist.update({
            where: { id: watchlistId },
            data: { lastRunAt: runAt, lastError: fetchResult.error },
        });
        return { watchlistId, newPostings: 0, seenAgain: 0, closed: 0, refreshedAlive: 0, error: fetchResult.error };
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
    // Story S6.2 — per-watchlist notification mode gates per-posting dispatch:
    //   "each"   — fire per posting (current behavior, subject to first-run digest)
    //   "digest" — suppress; posting-digest scheduler rolls them up daily
    //   "silent" — never notify (postings still land in the feed)
    const modeAllowsPerPosting = watchlist.notificationMode === "each";
    const willNotifyForNew = modeAllowsPerPosting && (!isFirstRun || fetchResult.postings.length <= FIRST_RUN_NOTIFY_LIMIT);

    // Negative-filter gate (parity with /api/postings GET). Postings matching
    // the global or per-watchlist negative filter still land in the
    // JobPosting table — the user can surface them later by toggling the
    // filter off or hitting ?includeFiltered=true. We only suppress the
    // *notification*. Compiled once per run; both regex sets cached by JSON
    // identity in lib/postings/negative-filters.ts.
    const globalSettingRow = await findGlobalSetting();
    const globalNegativeRegexes = compileNegativeFiltersFromArray(
        globalSettingRow ? parseGlobalSetting(globalSettingRow).negativeFilters : [],
    );
    const watchlistNegativeRegexes = compileNegativeFilters(watchlist.negativeFilters);

    // Pre-compute externalIds + one bulk existence check. Replaces what used
    // to be a per-posting findUnique. Two reasons: (1) lets us gate the
    // Tier-B LLM classifier to brand-new postings only without a second
    // DB pass, (2) one indexed `in (…)` query is cheaper than N findUniques.
    // The P2002 fallback below still handles the unique-constraint race
    // between this lookup and the create.
    //
    // SELECT also pulls existing `employmentType` so the seen-again UPDATE
    // below can preserve a previously-classified value when this crawl's
    // heuristic returns null (the title was always heuristic-resistant; we
    // already paid for the LLM call last time).
    const postingsWithIds = fetchResult.postings.map(raw => ({
        raw,
        externalId: externalIdFor(raw.company, raw.title, raw.sourceUrl),
    }));
    const existingRows = await prisma.jobPosting.findMany({
        where: { watchlistId, externalId: { in: postingsWithIds.map(p => p.externalId) } },
        select: { id: true, externalId: true, employmentType: true },
    });
    const existingByExternalId = new Map(
        existingRows.map(r => [r.externalId, { id: r.id, employmentType: r.employmentType }] as const),
    );

    // Cross-watchlist classification reuse — before reaching for the LLM,
    // check whether any OTHER watchlist has already classified the same
    // externalId. Same externalId means same `company|title|sourceUrl`, so
    // the classification is portable across watchlists. Cuts duplicate LLM
    // spend on aggregator-style watchlists (LinkedIn search, careers-page)
    // that overlap on the same posting. Candidates are (a) brand-new
    // postings whose heuristic returned null, AND (b) existing rows in this
    // watchlist that have null employmentType (self-heal path for rows
    // that got wiped by the pre-2026-05-24 update bug).
    const lookupCandidates = postingsWithIds.filter(p => {
        if (p.raw.employmentType != null) return false;
        const existing = existingByExternalId.get(p.externalId);
        if (existing == null) return true; // new posting
        return existing.employmentType == null; // existing but never successfully classified
    });
    if (lookupCandidates.length > 0) {
        const crossRows = await prisma.jobPosting.findMany({
            where: {
                externalId: { in: lookupCandidates.map(p => p.externalId) },
                employmentType: { not: null },
            },
            select: { externalId: true, employmentType: true },
            distinct: ["externalId"],
        });
        const cross = new Map(crossRows.map(r => [r.externalId, r.employmentType]));
        let reused = 0;
        for (const p of lookupCandidates) {
            const t = cross.get(p.externalId);
            // Narrow Prisma's `string | null` to the EmploymentType enum.
            // Anything outside the enum (shouldn't happen — every write to
            // this column goes through normalizeEmploymentType or the
            // classifier's enum schema) gets ignored rather than corrupting
            // raw.employmentType.
            if (t != null && (EMPLOYMENT_TYPES as readonly string[]).includes(t)) {
                p.raw.employmentType = t as EmploymentType;
                reused++;
            }
        }
        if (reused > 0) {
            console.info(
                `[job-watcher] employment-type cross-watchlist reuse: ${reused}/${lookupCandidates.length} postings classified without LLM call`,
            );
        }
    }

    // Tier B (employment-type classifier): for postings that are NEW to this
    // watchlist AND whose heuristic in lib/fetchers/employment-type.ts returned
    // null AND weren't backfilled by cross-watchlist reuse above, batch-
    // classify via Gemini Flash. Backfills `raw.employmentType` in place so
    // the create branch below picks it up. Strictly degrades — any failure
    // logs and falls through to ingest as Unspecified.
    const classifyInputs = postingsWithIds
        .filter(p => !existingByExternalId.has(p.externalId) && p.raw.employmentType == null)
        .map(p => ({
            id: p.externalId,
            company: p.raw.company,
            title: p.raw.title,
            snippet: p.raw.snippet,
            location: p.raw.location,
        }));
    if (classifyInputs.length > 0) {
        try {
            const classified = await classifyEmploymentTypes(classifyInputs);
            for (const p of postingsWithIds) {
                const t = classified.get(p.externalId);
                if (t !== undefined && p.raw.employmentType == null) {
                    p.raw.employmentType = t;
                }
            }
        } catch (e) {
            console.warn(`[job-watcher] employment-type classifier failed; new postings will be ingested as Unspecified:`, e);
        }
    }

    for (const { raw, externalId } of postingsWithIds) {
        seenExternalIds.add(externalId);
        const existing = existingByExternalId.get(externalId);
        if (existing) {
            // Always refresh lastSeenAt. Refresh employmentType ONLY when
            // raw.employmentType is non-null — otherwise we'd wipe a value
            // previously set by the LLM classifier (the heuristic can't
            // classify the title; that's why we paid for the LLM call) or
            // by cross-watchlist reuse above. Promote a null stored value
            // to a non-null raw value when the heuristic / cross-watchlist
            // reuse improves later.
            await prisma.jobPosting.update({
                where: { id: existing.id },
                data: {
                    lastSeenAt: runAt,
                    ...(raw.employmentType != null ? { employmentType: raw.employmentType } : {}),
                },
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
            // Story S5.9 — parse comp out of (title + snippet + location). Some
            // ATSes (Greenhouse Engage, occasional Lever) put pay info in the
            // title; most put it in the snippet body. Failing to parse leaves
            // every comp column NULL, which is fine — the row is still useful.
            const compHaystack = [raw.title, raw.snippet, raw.location].filter(Boolean).join("\n");
            const comp = parseCompensation(compHaystack);
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
                    compensationMin: comp?.min ?? null,
                    compensationMax: comp?.max ?? null,
                    compensationCurrency: comp?.currency ?? null,
                    compensationCadence: comp?.cadence ?? null,
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
                // Lost race against a parallel run that just created this
                // row. Same preserve-on-null rule as the regular seen-again
                // path above — don't wipe an LLM-classified value with a
                // null heuristic result.
                await prisma.jobPosting.update({
                    where: { watchlistId_externalId: { watchlistId, externalId } },
                    data: {
                        lastSeenAt: runAt,
                        ...(raw.employmentType != null ? { employmentType: raw.employmentType } : {}),
                    },
                });
                seenAgain++;
                continue;
            }
            throw e;
        }
        const postingForFilter = { title: raw.title, snippet: raw.snippet, location: raw.location };
        const filteredOut =
            matchesNegativeFilters(postingForFilter, globalNegativeRegexes) ||
            matchesNegativeFilters(postingForFilter, watchlistNegativeRegexes);
        if (willNotifyForNew && !filteredOut) {
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
                    // PB-8: one notification per externalId, ever. Originally
                    // keyed on `posting:${created.id}` which made the dedup
                    // per-row — same job in two watchlists got the user two
                    // notifications (verified in prod for Securitas /
                    // Rocket Lab / Raytheon overlap between cmpj4qgm and
                    // cmphm3g7). externalId is the same hash across
                    // watchlists when company+title+sourceUrl match, so
                    // keying on it collapses cross-watchlist dups at the
                    // notification layer. The first watchlist that surfaces
                    // the posting wins the notification (its postingId +
                    // watchlistId end up in the payload).
                    dedupKey: `posting:${externalId}`,
                });
            } catch (e) {
                console.warn(`[job-watcher] dispatchNotification failed for posting ${created.id}:`, e);
            }
        }
        newPostings++;
    }

    // Closed-posting detection (story S5.7, probe-gated as of 2026-05-25 —
    // see docs/close-detection-probe.md).
    //
    // Stale candidates = postings on this watchlist that were NOT in this
    // run's fetch AND haven't been seen in 6h+. Pre-probe-gate (bug-C era),
    // every stale candidate was unconditionally flipped to status="closed".
    // That was wrong for every fetcher whose view of the source is
    // incomplete (LinkedIn's 24h filter, Workday's per-crawl page cap on
    // 1k+-job tenants — 92–97% false-close rate measured 2026-05-25).
    //
    // Now: each stale candidate's sourceUrl is GET-probed via
    // lib/postings/liveness.ts:probeBatch. Only positive evidence of
    // removal (404/410, source-specific redirects, closure markers) flips
    // the row. "alive" results bump lastSeenAt — chronically absent-from-
    // fetch-but-live postings (LinkedIn's 24h window) never false-close.
    // "unknown" results leave the row alone; the next tick re-probes.
    //
    // SAFETY 1 — skip on empty fetch: a benign source hiccup (SPA mis-
    // render, CDN flap) would otherwise mark every existing row stale.
    // SAFETY 2 — skip on partial fetch: pagination broke mid-crawl; the
    // un-fetched portion is unknown territory, don't mass-close it.
    // SAFETY 3 — skip on first run: nothing prior to compare against.
    //
    // P2029 caveat (kept for posterity): the previous notIn-based shape
    // exceeded SQLite's 999-param cap and silently aborted for SpaceX
    // (1688), Boeing (1114), Blue Origin (981). The current code uses
    // SELECT-then-diff-then-UPDATE-by-id, where the close UPDATE uses
    // `id: in: [...]` (splittable by Prisma) on the smaller "confirmed
    // closed" subset.
    let closed = 0;
    let refreshedAlive = 0;
    if (!isFirstRun && fetchResult.postings.length > 0 && !fetchResult.partial) {
        const sixHoursAgo = new Date(runAt.getTime() - 6 * 60 * 60 * 1000);
        const staleCandidates = await prisma.jobPosting.findMany({
            where: {
                watchlistId,
                status: { notIn: ["closed", "hidden"] },
                lastSeenAt: { lt: sixHoursAgo },
            },
            select: { id: true, externalId: true, sourceUrl: true },
        });
        const toProbe = staleCandidates.filter(c => !seenExternalIds.has(c.externalId));
        if (toProbe.length > 0) {
            const probeResults = await probeBatch(
                toProbe.map(c => ({ externalId: c.externalId, sourceUrl: c.sourceUrl })),
                watchlist.kind as WatchlistKind,
            );
            const confirmedClosedIds: string[] = [];
            const aliveIds: string[] = [];
            for (const c of toProbe) {
                const verdict = probeResults.get(c.externalId) ?? "unknown";
                if (verdict === "closed") confirmedClosedIds.push(c.id);
                else if (verdict === "alive") aliveIds.push(c.id);
                // "unknown" → leave the row alone; the next tick re-evaluates.
            }
            // Race-guard: a probe round can take minutes on LinkedIn
            // (30 probes × 1.5 s = 45 s) or seconds on Workday. If during
            // the probe window the user clicks "Hide" on a row, their
            // manual action must beat the gate. Re-assert "still non-
            // terminal" in the WHERE so a concurrent user UPDATE wins.
            if (confirmedClosedIds.length > 0) {
                const closeResult = await prisma.jobPosting.updateMany({
                    where: {
                        id: { in: confirmedClosedIds },
                        status: { notIn: ["closed", "hidden"] },
                    },
                    data: { status: "closed", removedAt: runAt },
                });
                closed = closeResult.count;
            }
            if (aliveIds.length > 0) {
                const aliveResult = await prisma.jobPosting.updateMany({
                    where: {
                        id: { in: aliveIds },
                        status: { notIn: ["closed", "hidden"] },
                    },
                    data: { lastSeenAt: runAt },
                });
                refreshedAlive = aliveResult.count;
            }
            const skipped = toProbe.length - confirmedClosedIds.length - aliveIds.length;
            if (skipped > 0 || refreshedAlive > 0 || closed > 0) {
                console.info(
                    `[job-watcher] probe-gate watchlist=${watchlistId} kind=${watchlist.kind}: ` +
                    `candidates=${toProbe.length} closed=${closed} alive=${refreshedAlive} unknown=${skipped}`,
                );
            }
        }
        if (closed > 0) {
            // Standard tier — important enough to flag in the bell, but no
            // email blast. The user will see it next time they open MC.
            // PB-8: dedup on watchlist + day so a flapping source can't spam.
            await dispatchNotification({
                userId: watchlist.userId,
                tier: "standard",
                kind: "system",
                title: `${watchlist.name} — ${closed} ${closed === 1 ? "posting" : "postings"} closed`,
                body: "Removed from the source feed and confirmed unreachable.",
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

    return { watchlistId, newPostings, seenAgain, closed, refreshedAlive, error: null };
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
            results.push({ watchlistId: c.id, newPostings: 0, seenAgain: 0, closed: 0, refreshedAlive: 0, error: msg });
        }
    }
    return { processed: due.length, results };
}
