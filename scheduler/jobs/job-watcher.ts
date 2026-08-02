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
 * Plus one housekeeping helper, `reconcileClosedPostingCascade()` — invoked by
 * the scheduler at the top of every job-watcher tick (before the crawl pass)
 * to re-fire the Pillar C → A cascade for INTERESTED cards whose posting is
 * already closed but whose cascade was missed (P5.1).
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
import { findGlobalSettingForUser, parseGlobalSetting } from "@/lib/repositories/settings";
import { parseCompensation } from "@/lib/postings/compensation";
import { probeBatch, PROBE_PROFILES, type WatchlistKind } from "@/lib/postings/liveness";
import { closeApplicationsForClosedPostings } from "@/lib/applications/close-from-posting";

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

/**
 * C3 (closed-jobs feature, 2026-06-09) — per-kind budget for the proactive,
 * rotating re-probe of still-listed postings (Gap A). Deliberately SMALLER than
 * the stale-probe's PROBE_PROFILES[kind].maxPerTick so the proactive sweep never
 * starves close-detection of its rate budget on the shared IP. A conservative
 * default (a small fraction of maxPerTick, capped low) spreads a full pass over
 * the still-listed population across many ticks.
 *
 * TODO: size from the C0 audit (Track B) once it reports the still-listed
 * population per kind + a target 24–48 h freshness window. Until then this
 * conservative cap keeps C3 polite by construction.
 */
const C3_BUDGET_FRACTION = 0.1; // re-probe at most ~10% of a kind's stale cap per tick
const C3_BUDGET_HARD_CAP = 20;  // …and never more than this many, regardless of kind
export function c3BudgetForKind(kind: WatchlistKind): number {
    const profile = PROBE_PROFILES[kind];
    if (!profile) return 0;
    const sized = Math.floor(profile.maxPerTick * C3_BUDGET_FRACTION);
    return Math.max(1, Math.min(sized, C3_BUDGET_HARD_CAP));
}

/**
 * OQ7a — aggregator feeds vs first-party ATS feeds, for the C3 sweep's
 * "skip fetch-seen rows" rule. On a first-party feed (the employer's own ATS
 * API / careers page: greenhouse, lever, ashby, workday, …) a posting
 * appearing in the fetch IS evidence the detail page is open, so C3 skips
 * fetch-seen rows. On an aggregator's search feed (the LinkedIn / Indeed
 * guest-search scrapes) listing-presence ≠ detail-page-open — cards linger in
 * search results after the posting stops accepting applications — so C3 must
 * probe fetch-seen rows there too. (Same membership as FRAGILE_SOURCES below,
 * but a distinct concept: that one is about crawl pacing, this one is about
 * what a fetch sighting proves. Exported for the c3-cursor hermetic smoke.)
 */
export const AGGREGATOR_KINDS: ReadonlySet<WatchlistKind> = new Set<WatchlistKind>(["linkedin", "indeed"]);

/**
 * OQ5a time floor (2026-08-01) — minimum age a `pendingClosedAt` stamp must
 * reach before a second "closed" verdict may CONFIRM the close.
 *
 * The two-strike rule wants two closed verdicts from probe rounds far enough
 * apart that a transient (ATS maintenance window, CDN flap, degraded shell)
 * has had time to clear. Without a floor, "two consecutive ticks" was really
 * just "pendingClosedAt non-null at SELECT time": a scheduler tick stamping at
 * T could be confirmed by a manual "Run now" at T+10s (the
 * /api/watchlists/[id]/run route calls the same runWatchlist against the same
 * DB), or by a fast owner-debugging cadence — collapsing the two-strike rule
 * into a one-transient sticky close. Sticky is the operative word: a confirmed
 * close cascades into auto-closing linked INTERESTED cards, and false-closed
 * rows never self-heal (the stale re-probe excludes status="closed", the C3
 * sweep selects only status="new"; recovery is a manual script).
 *
 * A closed verdict on a stamp YOUNGER than the floor leaves the row untouched
 * — deliberately NOT re-stamped, since pushing the stamp forward would let a
 * rapid-run burst defer confirmation forever. The stamp stays put and a later
 * round confirms once it has aged past the floor.
 *
 * Why 30 minutes is conservative against real cadences: the API-created
 * default is scheduleMinutes=240 (lib/schemas/watchlists.ts) and the crew
 * floor is 60 (CREW_MIN_SCHEDULE_MINUTES) — so on every normal schedule the
 * next tick arrives with the stamp already ≥ 60 min old, comfortably past the
 * floor, and a genuinely removed posting still closes on its second tick
 * exactly as before. Only a sub-30-minute cadence confirms later than tick 2
 * (on the first tick after the stamp turns 30 min old — e.g. ~31 min at a
 * 1-min debugging cadence); closing is never impossible at any cadence.
 *
 * Exported for the closed-detection hermetic smoke, which asserts both halves:
 * a rapid re-run must not confirm; an aged stamp must.
 */
export const MIN_PENDING_CLOSED_AGE_MS = 30 * 60 * 1000;

/**
 * OQ5a time CEILING (2026-08-02) — companion to MIN_PENDING_CLOSED_AGE_MS: the
 * maximum age at which a `pendingClosedAt` stamp still counts as the first half
 * of a two-strike close.
 *
 * The floor alone gave the stamp no expiry, and nothing else expires it either:
 * `pendingClosedAt` is cleared ONLY by an explicit "alive" verdict —
 * fetch-presence deliberately does not clear it (see the seen-again branch
 * above) and "unknown" preserves it. So a stamp laid down by one transient
 * survives indefinitely, which collapses the two-strike rule back into a
 * one-strike rule on a long enough timeline: a transient stamps on day 1, then
 * weeks of "unknown" (probe timeouts, probeBatch's 429 batch abort, the
 * arXiv-style cooldown) go by while the posting is listed and alive, then one
 * unrelated transient "closed" on day 30 confirms INSTANTLY — the stamp is
 * trivially older than the 30-minute floor. That is a sticky close plus the
 * kanban cascade off a single fresh transient: exactly what the floor exists
 * to prevent, just on a slower clock.
 *
 * So a stamp older than this is no longer a strike: it is re-stamped with
 * `runAt` and treated as a fresh FIRST strike. This does NOT reopen the
 * rapid-burst hole that makes a too-young stamp defer UNTOUCHED — re-stamping
 * only ever applies to a stamp already older than the ceiling, so no run
 * cadence can push confirmation out forever by re-stamping.
 *
 * Why 7 days:
 *   - It bounds how long one transient is remembered. Two closed verdicts must
 *     now land within a week of each other to confirm, so the day-1 / day-30
 *     pair above becomes two independent first strikes and closes nothing.
 *   - It leaves the primary (stale-probe) path untouched. A row absent from the
 *     fetch is re-probed EVERY tick, so consecutive verdicts are one cadence
 *     apart: 4 h on the API-created default (scheduleMinutes 240), 1 h on the
 *     crew floor (CREW_MIN_SCHEDULE_MINUTES) — 42× and 168× inside the ceiling.
 *   - It covers the C3 rolling re-probe at realistic populations. C3 revisits a
 *     row every ceil(stillListed / c3BudgetForKind(kind)) ticks, so at the
 *     default 4 h cadence a week spans ~42 ticks — e.g. 840 greenhouse rows
 *     (budget 20) or 252 workday rows (budget 6).
 *   - Where a C3 rotation IS slower than a week (a very large still-listed
 *     population on a low-budget kind), the failure mode is a close that keeps
 *     deferring — never a false one. That is the safe direction: a missed close
 *     leaves an open-looking row the user closes in one click, whereas a false
 *     close is sticky, cascades to the linked kanban card, and needs a manual
 *     recovery script.
 *
 * Exported for the hermetic smokes, which assert an expired stamp neither
 * confirms nor is lost — it re-stamps, and a later round confirms off that.
 */
export const MAX_PENDING_CLOSED_AGE_MS = 7 * 24 * 60 * 60 * 1000;

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

    // Negative-filter gates. Compiled once per run; both regex sets cached by
    // JSON identity in lib/postings/negative-filters.ts.
    //   - GLOBAL filter → an ingestion DROP (2026-05-29). Postings matching it
    //     are removed below BEFORE any existence query, cross-watchlist lookup,
    //     LLM classification, or row create — they never enter the system. The
    //     scheduler runs on a Mac mini; this saves all that wasted work on
    //     blacklisted titles.
    //   - PER-WATCHLIST filter → read-time only (unchanged). Matching postings
    //     still land in the JobPosting table (surface via ?includeFiltered=true);
    //     here we only suppress the per-posting *notification* (parity with the
    //     /api/postings GET feed filter).
    //
    // P2.3.1: "global" means global TO THE WATCHLIST'S OWNER — read their row,
    // never the owner account's. This drop is the highest-severity config bleed
    // in the codebase precisely because it happens before any DB write: a
    // posting dropped under someone else's blocklist leaves no row to notice,
    // so the loss is silent and permanent.
    const globalSettingRow = await findGlobalSettingForUser(watchlist.userId);
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

    // Record EVERY externalId the source returned as "seen" this run, BEFORE the
    // global-filter drop below. Close-detection keys on seenExternalIds; a
    // globally-filtered-but-still-live legacy row must count as seen so it's
    // never probed/closed (and re-dropped each run while it stays on the source).
    for (const p of postingsWithIds) seenExternalIds.add(p.externalId);

    // Global negative-filter ingestion DROP. Everything downstream (existence
    // query, cross-watchlist reuse, LLM classify, create, notify) operates on
    // `kept` — so a blacklisted title costs nothing past a cheap regex test.
    const kept = globalNegativeRegexes.length === 0
        ? postingsWithIds
        : postingsWithIds.filter(p => !matchesNegativeFilters(
            { title: p.raw.title, snippet: p.raw.snippet, location: p.raw.location },
            globalNegativeRegexes,
        ));
    const filteredAtIngest = postingsWithIds.length - kept.length;
    if (filteredAtIngest > 0) {
        console.info(`[job-watcher] dropped ${filteredAtIngest} posting(s) at ingest via global negative filter (watchlist=${watchlistId}) — not stored, not classified`);
    }

    const existingRows = await prisma.jobPosting.findMany({
        where: { watchlistId, externalId: { in: kept.map(p => p.externalId) } },
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
    const lookupCandidates = kept.filter(p => {
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
    //
    // Inline classification is gated to first-run crawls only — a brand-new
    // watchlist's first 50-2000 postings get classified inline so the user
    // sees employment types immediately after adding it. Subsequent crawls
    // leave new rows with employmentType=null; the lockstep scheduler job
    // `classify-pending-employment-types` (every 4h) batches every null row
    // across all watchlists in one consolidated LLM call. Saves the cost of
    // N small scattered batches when watchlists' cadence clocks drift apart.
    const classifyInputs = isFirstRun
        ? kept
            .filter(p => !existingByExternalId.has(p.externalId) && p.raw.employmentType == null)
            .map(p => ({
                id: p.externalId,
                company: p.raw.company,
                title: p.raw.title,
                snippet: p.raw.snippet,
                location: p.raw.location,
            }))
        : [];
    if (classifyInputs.length > 0) {
        try {
            const classified = await classifyEmploymentTypes(classifyInputs);
            for (const p of kept) {
                const t = classified.get(p.externalId);
                if (t !== undefined && p.raw.employmentType == null) {
                    p.raw.employmentType = t;
                }
            }
        } catch (e) {
            console.warn(`[job-watcher] employment-type classifier failed; new postings will be ingested as Unspecified:`, e);
        }
    }

    for (const { raw, externalId } of kept) {
        const existing = existingByExternalId.get(externalId);
        if (existing) {
            // Always refresh lastSeenAt. Refresh employmentType ONLY when
            // raw.employmentType is non-null — otherwise we'd wipe a value
            // previously set by the LLM classifier (the heuristic can't
            // classify the title; that's why we paid for the LLM call) or
            // by cross-watchlist reuse above. Promote a null stored value
            // to a non-null raw value when the heuristic / cross-watchlist
            // reuse improves later.
            //
            // OQ5a: deliberately do NOT clear pendingClosedAt here —
            // fetch-presence is not alive evidence (on aggregator feeds a
            // card lingers in search results after the posting closes).
            // Only an explicit "alive" probe verdict clears the stamp.
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
        // Global-filtered postings were dropped at ingest above, so only the
        // per-watchlist filter can suppress a per-posting notification here.
        const filteredOut = matchesNegativeFilters(
            { title: raw.title, snippet: raw.snippet, location: raw.location },
            watchlistNegativeRegexes,
        );
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
    // see docs/archive/close-detection-probe.md).
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
    // OQ5a (P3.2, 2026-06-12): a single "closed" verdict no longer flips the
    // row — it requires TWO CONSECUTIVE closed verdicts across ticks. The
    // first stamps JobPosting.pendingClosedAt (no status change, no cascade,
    // not counted in `closed`); the second, on a still-pending row whose stamp
    // sits inside the OQ5a confirm WINDOW — at least MIN_PENDING_CLOSED_AGE_MS
    // and at most MAX_PENDING_CLOSED_AGE_MS old (2026-08-01 / 2026-08-02, see
    // those constants) — confirms the close. Outside the window nothing closes:
    // a stamp younger than the floor defers UNTOUCHED to a later round, and a
    // stamp older than the ceiling is re-stamped as a fresh first strike so a
    // months-old transient can never be half of a confirmation. An explicit
    // "alive" verdict clears the pending stamp;
    // fetch-presence does NOT (on aggregator feeds a listing sighting isn't
    // alive evidence); "unknown" preserves it (absence of evidence neither
    // confirms nor clears). Manual feed-close (postings PATCH) bypasses this
    // entirely — user action confirms itself.
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
    // Closed-jobs cascade (OQ7/OQ8/OQ9): linked INTERESTED cards auto-closed by
    // a confirmed-closed posting this run — folded into the closure-summary
    // bell row below rather than blasted per-card.
    let cascadeClosed = 0;
    // externalIds the stale-probe already hit this tick — so the C3 sweep below
    // doesn't double-probe a stale-but-alive row (still status="new") in the
    // same tick.
    const staleProbedExternalIds = new Set<string>();
    // Board-level id for the kinds whose per-posting liveness API is addressed
    // as (board, posting). Only clearcompany today: its detail endpoint is
    // careers-api.clearcompany.com/v1/<siteId>/<jobId> and the siteId lives
    // ONLY here in the watchlist config — it is absent from the posting URL and
    // from the posting page. Passed to both probeBatch call sites below; a kind
    // that needs it and doesn't get it resolves "unknown", never "closed".
    const probeBoardKey = config.kind === "clearcompany" ? config.boardSlug : undefined;
    if (!isFirstRun && fetchResult.postings.length > 0 && !fetchResult.partial) {
        const sixHoursAgo = new Date(runAt.getTime() - 6 * 60 * 60 * 1000);
        // OQ5a confirm window — a pending stamp confirms only when it is OLDER
        // than the floor cutoff and NEWER than the expiry cutoff, i.e.
        // pendingClosedAt ∈ [pendingExpiryCutoff, pendingConfirmCutoff).
        // Computed once per run; used by both the stale-probe and C3 partitions
        // below and re-asserted in both confirm UPDATEs' WHERE.
        const pendingConfirmCutoff = new Date(runAt.getTime() - MIN_PENDING_CLOSED_AGE_MS);
        const pendingExpiryCutoff = new Date(runAt.getTime() - MAX_PENDING_CLOSED_AGE_MS);
        const staleCandidates = await prisma.jobPosting.findMany({
            where: {
                watchlistId,
                status: { notIn: ["closed", "hidden"] },
                lastSeenAt: { lt: sixHoursAgo },
            },
            select: { id: true, externalId: true, sourceUrl: true, pendingClosedAt: true },
        });
        const toProbe = staleCandidates.filter(c => !seenExternalIds.has(c.externalId));
        for (const c of toProbe) staleProbedExternalIds.add(c.externalId);
        if (toProbe.length > 0) {
            const probeResults = await probeBatch(
                toProbe.map(c => ({ externalId: c.externalId, sourceUrl: c.sourceUrl, boardKey: probeBoardKey })),
                watchlist.kind as WatchlistKind,
            );
            // OQ5a two-tick partition: a closed verdict on a row already
            // stamped pendingClosedAt (a prior tick's verdict) CONFIRMS the
            // close; on an unstamped row it's the FIRST STRIKE — stamp only.
            const confirmedClosedIds: string[] = [];
            const firstStrikeClosedIds: string[] = [];
            const expiredRestampIds: string[] = [];
            const aliveIds: string[] = [];
            let deferredTooYoung = 0;
            for (const c of toProbe) {
                const verdict = probeResults.get(c.externalId) ?? "unknown";
                if (verdict === "closed") {
                    if (c.pendingClosedAt == null) firstStrikeClosedIds.push(c.id);
                    // Stamp older than MAX_PENDING_CLOSED_AGE_MS → expired: it
                    // is no longer evidence of anything, so this verdict starts
                    // the two-strike clock over rather than confirming off a
                    // months-old transient (see the constant's doc).
                    else if (c.pendingClosedAt.getTime() < pendingExpiryCutoff.getTime()) expiredRestampIds.push(c.id);
                    else if (c.pendingClosedAt.getTime() < pendingConfirmCutoff.getTime()) confirmedClosedIds.push(c.id);
                    // Stamp younger than MIN_PENDING_CLOSED_AGE_MS → defer:
                    // leave the row untouched (NOT re-stamped — see the
                    // constant's doc), so a rapid second run (manual "Run now"
                    // seconds after a scheduler tick) cannot confirm off one
                    // transient. A later round confirms once the stamp ages.
                    else deferredTooYoung++;
                } else if (verdict === "alive") aliveIds.push(c.id);
                // "unknown" → leave the row alone (pendingClosedAt untouched);
                // the next tick re-evaluates.
            }
            // Race-guard: a probe round can take minutes on LinkedIn
            // (30 probes × 1.5 s = 45 s) or seconds on Workday. If during
            // the probe window the user clicks "Hide" on a row, their
            // manual action must beat the gate. Re-assert "still non-
            // terminal" in the WHERE so a concurrent user UPDATE wins.
            if (firstStrikeClosedIds.length > 0) {
                // First closed verdict — stamp pendingClosedAt only. No status
                // change, no cascade, no closed-count, no notification: the
                // next tick's verdict decides.
                await prisma.jobPosting.updateMany({
                    where: {
                        id: { in: firstStrikeClosedIds },
                        status: { notIn: ["closed", "hidden"] },
                        // Re-assert STILL UNSTAMPED. These ids were selected
                        // because pendingClosedAt was null at SELECT time; if a
                        // concurrent run (web tier vs scheduler — the mutex is
                        // per-process) stamped the row during the probe window,
                        // its stamp stands. Without this, the later run's write
                        // could BACKDATE the stamp to its own earlier `runAt`
                        // and shorten the floor. One stamp per pending episode.
                        pendingClosedAt: null,
                    },
                    data: { pendingClosedAt: runAt },
                });
            }
            if (expiredRestampIds.length > 0) {
                // Stamp aged past the ceiling — restart the two-strike clock.
                // Same shape as a first strike (stamp only, no status change,
                // no cascade, no closed-count), and the WHERE re-asserts the
                // row is STILL expired so a concurrent run that already
                // re-stamped it keeps its fresher stamp.
                await prisma.jobPosting.updateMany({
                    where: {
                        id: { in: expiredRestampIds },
                        status: { notIn: ["closed", "hidden"] },
                        pendingClosedAt: { not: null, lt: pendingExpiryCutoff },
                    },
                    data: { pendingClosedAt: runAt },
                });
            }
            if (confirmedClosedIds.length > 0) {
                const closeResult = await prisma.jobPosting.updateMany({
                    where: {
                        id: { in: confirmedClosedIds },
                        status: { notIn: ["closed", "hidden"] },
                        // Re-assert still-pending AND inside the OQ5a confirm
                        // window: a concurrent process (manual run in the
                        // Next.js tier vs the scheduler) may have cleared the
                        // stamp on alive evidence during the probe window —
                        // its evidence wins — or re-stamped it moments ago,
                        // in which case the too-young stamp must not confirm.
                        // `gte` closes the other end: an expired stamp is not
                        // a strike, so it must not confirm here either.
                        pendingClosedAt: { not: null, gte: pendingExpiryCutoff, lt: pendingConfirmCutoff },
                    },
                    data: { status: "closed", removedAt: runAt, pendingClosedAt: null },
                });
                closed = closeResult.count;
                // Pillar C → A cascade (OQ7/OQ8): close linked INTERESTED cards
                // for the postings just confirmed closed. Per-tier, same DB.
                const cascade = await closeApplicationsForClosedPostings(confirmedClosedIds, {
                    at: runAt,
                    source: "probe",
                }).catch(e => {
                    console.warn(`[job-watcher] cascade close failed (watchlist=${watchlistId}):`, e);
                    return { closedAppIds: [] as string[] };
                });
                cascadeClosed += cascade.closedAppIds.length;
            }
            if (aliveIds.length > 0) {
                const aliveResult = await prisma.jobPosting.updateMany({
                    where: {
                        id: { in: aliveIds },
                        status: { notIn: ["closed", "hidden"] },
                    },
                    // Explicit alive evidence clears a pending close stamp.
                    data: { lastSeenAt: runAt, pendingClosedAt: null },
                });
                refreshedAlive = aliveResult.count;
            }
            const skipped = toProbe.length - confirmedClosedIds.length - firstStrikeClosedIds.length
                - expiredRestampIds.length - aliveIds.length - deferredTooYoung;
            if (skipped > 0 || refreshedAlive > 0 || closed > 0 || firstStrikeClosedIds.length > 0
                || expiredRestampIds.length > 0 || deferredTooYoung > 0) {
                console.info(
                    `[job-watcher] probe-gate watchlist=${watchlistId} kind=${watchlist.kind}: ` +
                    `candidates=${toProbe.length} closed=${closed} pending=${firstStrikeClosedIds.length} ` +
                    `expired=${expiredRestampIds.length} deferred=${deferredTooYoung} ` +
                    `alive=${refreshedAlive} unknown=${skipped}`,
                );
            }
        }

        // ─── C3 · budgeted, rotating re-probe of still-listed postings ──────
        // Gap A: a closed-but-still-listed posting never goes stale (the fetch
        // keeps bumping lastSeenAt at :330), so the stale-probe above never
        // selects it. C3 adds a second, proactive sweep that re-probes
        // status="new" postings ordered by lastProbedAt ASC (nulls first) — a
        // durable rolling cursor with no in-memory state to lose on restart.
        //
        // Budget: a per-kind cap SEPARATE FROM and SMALLER THAN the stale-
        // probe's maxPerTick, so the proactive sweep never starves close-
        // detection of its rate budget on the shared IP. Reuses the same
        // PROBE_PROFILES concurrency/delay + probeBatch's 429-abort flag +
        // arXiv-style cooldown awareness (all internal to probeBatch).
        //
        // Verdict handling is IDENTICAL to the stale path (incl. the OQ5a
        // two-tick confirmation):
        //   closed  → first verdict stamps pendingClosedAt; a second
        //             consecutive one flips status="closed" + the Pillar
        //             C → A cascade (source:probe)
        //   alive   → bump lastSeenAt + clear pendingClosedAt
        //   unknown → leave the row alone (pendingClosedAt preserved).
        // OQ6a: lastProbedAt is stamped on EVERY candidate selected into the
        // take-window — probed AND skipped — so the column means "last
        // considered by a probe sweep", not "actually probed". Stamping the
        // skipped candidates is what keeps the cursor moving: a fetch-seen row
        // left at NULL would otherwise sit at the front of the ORDER BY
        // lastProbedAt ASC window forever and jam the rotation for every row
        // behind it.
        const c3Budget = c3BudgetForKind(watchlist.kind as WatchlistKind);
        if (c3Budget > 0) {
            const c3Candidates = await prisma.jobPosting.findMany({
                where: { watchlistId, status: "new" },
                // nulls-first: SQLite sorts NULL before non-NULL on ASC, so a
                // never-considered row (lastProbedAt = NULL) is picked up first.
                orderBy: { lastProbedAt: "asc" },
                take: c3Budget,
                select: { id: true, externalId: true, sourceUrl: true, pendingClosedAt: true },
            });
            // Within-tick skip rules:
            //   - staleProbedExternalIds (ALL kinds): the stale-probe already
            //     GET-probed this row seconds ago — never double-probe within
            //     one tick.
            //   - seenExternalIds (FIRST-PARTY kinds only, OQ7a): on an
            //     employer-owned feed a fetch sighting proves the posting is
            //     open, so probing it milliseconds later is wasted budget. On
            //     AGGREGATOR feeds (LinkedIn / Indeed) the sighting proves
            //     nothing about the detail page, so fetch-seen rows are still
            //     probed there — that's the whole point of the C3 sweep for
            //     those kinds.
            const isAggregatorKind = AGGREGATOR_KINDS.has(watchlist.kind as WatchlistKind);
            const c3ToProbe = c3Candidates.filter(
                c => !staleProbedExternalIds.has(c.externalId)
                    && (isAggregatorKind || !seenExternalIds.has(c.externalId)),
            );
            if (c3ToProbe.length > 0) {
                const c3Results = await probeBatch(
                    c3ToProbe.map(c => ({ externalId: c.externalId, sourceUrl: c.sourceUrl, boardKey: probeBoardKey })),
                    watchlist.kind as WatchlistKind,
                    { profile: { maxPerTick: c3Budget } },
                );
                // OQ5a two-tick partition — same rule as the stale path above,
                // including the MIN/MAX_PENDING_CLOSED_AGE_MS confirm window.
                const c3ConfirmedClosedIds: string[] = [];
                const c3FirstStrikeIds: string[] = [];
                const c3ExpiredRestampIds: string[] = [];
                const c3AliveIds: string[] = [];
                let c3DeferredTooYoung = 0;
                for (const c of c3ToProbe) {
                    const verdict = c3Results.get(c.externalId) ?? "unknown";
                    if (verdict === "closed") {
                        if (c.pendingClosedAt == null) c3FirstStrikeIds.push(c.id);
                        // Expired stamp → restart the clock (see the stale path).
                        // This branch matters MOST here: a C3-swept row is
                        // re-probed once per rotation, not once per tick, so its
                        // stamp is the one most likely to age out.
                        else if (c.pendingClosedAt.getTime() < pendingExpiryCutoff.getTime()) c3ExpiredRestampIds.push(c.id);
                        else if (c.pendingClosedAt.getTime() < pendingConfirmCutoff.getTime()) c3ConfirmedClosedIds.push(c.id);
                        // Too-young stamp → defer untouched (see the stale path).
                        else c3DeferredTooYoung++;
                    } else if (verdict === "alive") c3AliveIds.push(c.id);
                    // "unknown" → leave the row (pendingClosedAt preserved);
                    // lastProbedAt stamped below.
                }
                let c3Closed = 0;
                if (c3FirstStrikeIds.length > 0) {
                    // First closed verdict — stamp only; the next sweep decides.
                    // `pendingClosedAt: null` re-asserted so a concurrent run's
                    // stamp is never backdated (see the stale path).
                    await prisma.jobPosting.updateMany({
                        where: {
                            id: { in: c3FirstStrikeIds },
                            status: { notIn: ["closed", "hidden"] },
                            pendingClosedAt: null,
                        },
                        data: { pendingClosedAt: runAt },
                    });
                }
                if (c3ExpiredRestampIds.length > 0) {
                    await prisma.jobPosting.updateMany({
                        where: {
                            id: { in: c3ExpiredRestampIds },
                            status: { notIn: ["closed", "hidden"] },
                            pendingClosedAt: { not: null, lt: pendingExpiryCutoff },
                        },
                        data: { pendingClosedAt: runAt },
                    });
                }
                if (c3ConfirmedClosedIds.length > 0) {
                    const r = await prisma.jobPosting.updateMany({
                        where: {
                            id: { in: c3ConfirmedClosedIds },
                            status: { notIn: ["closed", "hidden"] },
                            // Same concurrent-alive race-guard + OQ5a confirm
                            // window as the stale path.
                            pendingClosedAt: { not: null, gte: pendingExpiryCutoff, lt: pendingConfirmCutoff },
                        },
                        data: { status: "closed", removedAt: runAt, pendingClosedAt: null },
                    });
                    c3Closed = r.count;
                    closed += c3Closed;
                    const cascade = await closeApplicationsForClosedPostings(c3ConfirmedClosedIds, {
                        at: runAt,
                        source: "probe",
                    }).catch(e => {
                        console.warn(`[job-watcher] C3 cascade close failed (watchlist=${watchlistId}):`, e);
                        return { closedAppIds: [] as string[] };
                    });
                    cascadeClosed += cascade.closedAppIds.length;
                }
                if (c3AliveIds.length > 0) {
                    await prisma.jobPosting.updateMany({
                        where: { id: { in: c3AliveIds }, status: { notIn: ["closed", "hidden"] } },
                        // Explicit alive evidence clears a pending close stamp.
                        data: { lastSeenAt: runAt, pendingClosedAt: null },
                    });
                }
                const c3Unknown = c3ToProbe.length - c3ConfirmedClosedIds.length - c3FirstStrikeIds.length
                    - c3ExpiredRestampIds.length - c3AliveIds.length - c3DeferredTooYoung;
                if (c3Closed > 0 || c3Unknown > 0 || c3AliveIds.length > 0 || c3FirstStrikeIds.length > 0
                    || c3ExpiredRestampIds.length > 0 || c3DeferredTooYoung > 0) {
                    console.info(
                        `[job-watcher] C3 re-probe watchlist=${watchlistId} kind=${watchlist.kind}: ` +
                        `probed=${c3ToProbe.length} closed=${c3Closed} pending=${c3FirstStrikeIds.length} ` +
                        `expired=${c3ExpiredRestampIds.length} deferred=${c3DeferredTooYoung} ` +
                        `alive=${c3AliveIds.length} unknown=${c3Unknown}`,
                    );
                }
            }
            // OQ6a — advance the rolling cursor: stamp lastProbedAt on EVERY
            // candidate this sweep pulled into its take-window, including the
            // ones skipped above (fetch-seen on a first-party kind / already
            // stale-probed) and the "unknown" verdicts. Skipping the stamp on
            // filtered-out rows is exactly what used to jam the rotation —
            // they kept lastProbedAt = NULL and were re-selected every tick.
            // Closed rows are stamped too; harmless since they exit the
            // status="new" selection.
            if (c3Candidates.length > 0) {
                await prisma.jobPosting.updateMany({
                    where: { id: { in: c3Candidates.map(c => c.id) } },
                    data: { lastProbedAt: runAt },
                });
            }
        }

        if (closed > 0) {
            // Standard tier — important enough to flag in the bell, but no
            // email blast. The user will see it next time they open MC.
            // PB-8: dedup on watchlist + day so a flapping source can't spam.
            //
            // OQ9: cascade-closed kanban cards fold into THIS summary rather
            // than a per-card blast (the per-card noise the circuit breaker
            // exists to prevent). When the close cascaded to one or more
            // INTERESTED cards, append the count to the body.
            const cascadeNote = cascadeClosed > 0
                ? ` ${cascadeClosed} linked ${cascadeClosed === 1 ? "card" : "cards"} moved to Closed.`
                : "";
            await dispatchNotification({
                userId: watchlist.userId,
                tier: "standard",
                kind: "system",
                title: `${watchlist.name} — ${closed} ${closed === 1 ? "posting" : "postings"} closed`,
                body: `Removed from the source feed and confirmed unreachable.${cascadeNote}`,
                payload: { watchlistId, closed, cascadeClosed },
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
        // The watchlist's owner is the only viewer these belong to — a crawl of
        // one crew member's watchlist must not wake every other client.
        broadcastEvent({ model: "Watchlist", action: "upsert", id: watchlistId, userId: watchlist.userId, timestamp: runAt.getTime() });
        if (newPostings > 0 || seenAgain > 0) {
            broadcastEvent({ model: "Posting", action: "upsert", id: watchlistId, userId: watchlist.userId, timestamp: runAt.getTime() });
        }
        if (newPostings > 0) {
            // `id` intentionally omitted: the notifications dispatched above are
            // fire-and-forget, so there is no single row to name. (It previously
            // carried `id: watchlist.userId` — one of three sites smuggling a
            // user id through the row-id field, all normalized together; see
            // lib/events.ts.)
            broadcastEvent({ model: "Notification", action: "upsert", userId: watchlist.userId, timestamp: runAt.getTime() });
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
 * P5.1 — idempotent top-of-run reconcile sweep (cascade catch-up).
 *
 * The Pillar C → A cascade fires inline when job-watcher confirms a posting
 * closed (stale-probe + C3 paths above) and when the user closes a posting
 * via the feed PATCH. Both call sites warn-swallow a cascade failure, and a
 * process crash between the posting flip and the cascade loses it entirely —
 * leaving an INTERESTED card pointing at a closed posting forever. This sweep
 * catches those rows: every INTERESTED application whose linked JobPosting is
 * status="closed" gets the SAME cascade re-run (close-from-posting.ts — the
 * logic is not duplicated here, so eligibility stays INTERESTED-only / OQ7).
 *
 * Postings merely in the OQ5a two-tick pending state (pendingClosedAt set,
 * status still "new") are NOT swept — the status="closed" relation filter
 * excludes them by construction; only a confirmed close cascades.
 *
 * Idempotent: a second run finds no INTERESTED+closed pairs (the first run
 * moved them to CLOSED) and the cascade itself re-asserts status='INTERESTED'
 * in its UPDATE WHERE, so a concurrent user drag still wins. Logs only when
 * something was actually reconciled; silent on the no-op steady state.
 *
 * `opts` is an injectable seam for the hermetic smoke (same pattern as
 * RunDueDeps above): `userId` scopes the sweep to throwaway rows so the
 * pre-push run can never touch real dev.db data; `at` pins event timestamps
 * for deterministic asserts. The scheduler passes nothing.
 */
export async function reconcileClosedPostingCascade(
    opts: { userId?: string; at?: Date } = {},
): Promise<{ closedAppIds: string[] }> {
    const orphans = await prisma.application.findMany({
        where: {
            status: "INTERESTED",
            ...(opts.userId ? { userId: opts.userId } : {}),
            // Fully-closed postings only — a null relation (postingId unset)
            // or a pendingClosedAt-stamped row (status still "new") never
            // matches. "hidden" is a user-curation state, not a close; it
            // does not cascade here either (parity with the inline call sites,
            // which only cascade on a confirmed status="closed" flip).
            posting: { is: { status: "closed" } },
        },
        select: { id: true, postingId: true },
    });
    if (orphans.length === 0) return { closedAppIds: [] };

    const postingIds = [...new Set(orphans.flatMap(o => (o.postingId ? [o.postingId] : [])))];
    const cascade = await closeApplicationsForClosedPostings(postingIds, {
        at: opts.at ?? new Date(),
        // Distinct provenance: tells a reader the ORIGINAL cascade was missed
        // and this row was healed by the sweep, not closed in-band. The
        // ApplicationEvent.syncSource column is a free string ("probe" and
        // "ms" are the in-band values).
        source: "reconcile",
    });
    if (cascade.closedAppIds.length > 0) {
        console.info(
            `[job-watcher] reconcile sweep closed ${cascade.closedAppIds.length} INTERESTED app(s) ` +
            `whose posting had already closed — apps=[${cascade.closedAppIds.join(", ")}]`,
        );
    }
    return cascade;
}

// Scraped aggregators (LinkedIn, Indeed) bot-detect on bursts; their fetchers
// hit guest HTML endpoints with no auth. ATS APIs (greenhouse, lever, ashby,
// workday, …) are first-party JSON endpoints that don't care about cadence, so
// they're NOT spaced. `runDueWatchlists` inserts a jittered gap between
// consecutive crawls to fragile sources within a single tick.
const FRAGILE_SOURCES = new Set<string>(["linkedin", "indeed"]);
export function isFragileSource(kind: string): boolean {
    return FRAGILE_SOURCES.has(kind);
}

const INTER_CRAWL_JITTER_MIN_MS = 3_000;
const INTER_CRAWL_JITTER_MAX_MS = 10_000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const defaultJitterMs = () =>
    INTER_CRAWL_JITTER_MIN_MS + Math.floor(Math.random() * (INTER_CRAWL_JITTER_MAX_MS - INTER_CRAWL_JITTER_MIN_MS));

/**
 * Injectable seams for `runDueWatchlists`. The scheduler calls it with no args
 * (all defaults); the hermetic smoke injects all four so it can assert the
 * inter-crawl pacing without a DB, network, or real timer.
 */
export interface RunDueDeps {
    /** Resolve the due watchlists (id + source kind). Default = active rows
     *  whose lastRunAt is older than scheduleMinutes, read from the DB. */
    loadDue?: () => Promise<Array<{ id: string; kind: string }>>;
    /** Crawl one watchlist. Default = processOne(id, { broadcast: false }). */
    processFn?: (id: string) => Promise<RunResult>;
    /** Sleep between consecutive fragile-source crawls. Default = real timer. */
    sleepFn?: (ms: number) => Promise<void>;
    /** Jitter duration per gap, ms. Default = random in [3s, 10s). */
    jitterMs?: () => number;
}

async function defaultLoadDue(): Promise<Array<{ id: string; kind: string }>> {
    const now = Date.now();
    const candidates = await prisma.watchlist.findMany({
        where: { active: true },
        select: { id: true, kind: true, scheduleMinutes: true, lastRunAt: true },
    });
    return candidates
        .filter((c) => !c.lastRunAt || now - c.lastRunAt.getTime() >= c.scheduleMinutes * 60_000)
        .map((c) => ({ id: c.id, kind: c.kind }));
}

/**
 * Scheduler tick — invoked by setInterval in scheduler/index.ts. Loops over
 * every active watchlist whose lastRunAt is older than `scheduleMinutes`,
 * crawling serially. Doesn't broadcast (different process).
 *
 * Burst control: a jittered gap (3–10s) is inserted BEFORE the 2nd, 3rd, …
 * crawl to a fragile scraped source (LinkedIn/Indeed) in the same tick — never
 * before the first, never after the last, never around ATS-API sources. This
 * matters most after a >cadence scheduler downtime, when every overdue
 * watchlist comes due on the first tick back and would otherwise crawl LinkedIn
 * back-to-back with zero delay. A throw still counts as a fragile attempt, so
 * the following fragile crawl is still spaced.
 */
export async function runDueWatchlists(deps: RunDueDeps = {}): Promise<{ processed: number; results: RunResult[] }> {
    const loadDue = deps.loadDue ?? defaultLoadDue;
    const processFn = deps.processFn ?? ((id: string) => processOne(id, { broadcast: false }));
    const sleepFn = deps.sleepFn ?? sleep;
    const jitterMs = deps.jitterMs ?? defaultJitterMs;

    const due = await loadDue();
    const results: RunResult[] = [];
    let fragileProcessed = false;
    for (const c of due) {
        if (isFragileSource(c.kind) && fragileProcessed) {
            await sleepFn(jitterMs());
        }
        try {
            results.push(await processFn(c.id));
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.error(`[job-watcher] processOne(${c.id}) threw:`, e);
            results.push({ watchlistId: c.id, newPostings: 0, seenAgain: 0, closed: 0, refreshedAlive: 0, error: msg });
        }
        if (isFragileSource(c.kind)) fragileProcessed = true;
    }
    return { processed: due.length, results };
}
