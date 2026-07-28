import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth-guards";
import { broadcastEvent } from "@/lib/events";
import { WatchlistPostSchema, WatchlistTrackSchema } from "@/lib/schemas/watchlists";
import { hydrateWatchlistConfig, resolveCreatePayload } from "@/lib/watchlists/hydrate";
import { watchlistConfigKey } from "@/lib/company-directory";
import { clampInt } from "@/lib/rate-limit/process-bucket";
import { runWatchlist } from "@/scheduler/jobs/job-watcher";

export const runtime = "nodejs";

// P2.6.1 / OQ10a — per-crew watchlist cap. Bounds risk R7.
//
// A watchlist is not an inert row: it is a standing claim on shared, unmetered
// resources. `defaultLoadDue` selects EVERY active watchlist whose lastRunAt is
// older than its scheduleMinutes with NO ceiling
// (scheduler/jobs/job-watcher.ts:916-921), every crawl leaves this box's single
// residential IP (so the failure mode — a LinkedIn/Workday block — degrades
// EVERYONE's postings, not just the over-user's), and every newly-ingested
// posting can spend Gemini on the OWNER's key: `classifyEmploymentTypes` runs
// inside the scheduler and therefore sits deliberately OUTSIDE the per-user AI
// credit cap (docs/multi-user-crew.html §2.9's callout, R6). This count is the
// real, if indirect, ceiling on that scheduled spend — which is why it is not
// merely a UX limit and should not be quietly raised.
//
// The owner is exempt: they own the box, the IP and the API key. `0` is a legal
// value (crew may create none); module-level read, so changes need
// `pm2 restart … --update-env`, same as every other tunable here.
const CREW_WATCHLIST_LIMIT = clampInt(process.env.CREW_WATCHLIST_LIMIT, 5, 0, 1000);

/**
 * Thrown inside the create transaction to roll it back when a concurrent POST
 * won the race to the last slot. Caught by the POST handler's outer catch and
 * translated to the same 400 as the pre-check — never reaches the 500 branch.
 */
class WatchlistLimitExceeded extends Error {
    constructor(readonly current: number) {
        super(`watchlist limit ${CREW_WATCHLIST_LIMIT} exceeded (have ${current})`);
        this.name = "WatchlistLimitExceeded";
    }
}

/**
 * The over-limit rejection. 400 (not 403): the request is well-formed and the
 * caller is permitted here — this specific one cannot be satisfied. The body
 * NAMES the limit and the current count so the UI can state the rule plainly
 * instead of surfacing a generic failure; `error` stays a plain string because
 * `lib/api-client.ts:jsonFetch` throws `new Error(err.error)`.
 */
function limitReachedResponse(current: number): NextResponse {
    return NextResponse.json(
        {
            error:
                `Watchlist limit reached — you can have at most ${CREW_WATCHLIST_LIMIT} ` +
                `watchlist${CREW_WATCHLIST_LIMIT === 1 ? "" : "s"} (you have ${current}). ` +
                `Delete one to add another.`,
            reason: "watchlist-limit",
            limit: CREW_WATCHLIST_LIMIT,
            current,
        },
        { status: 400 },
    );
}

function userIdFromGuard(guard: { session: { user?: unknown } }): string | null {
    const user = guard.session.user as { id?: string } | undefined;
    return user?.id && user.id.length > 0 ? user.id : null;
}

function serialize(w: {
    id: string; userId: string; name: string; kind: string; config: string;
    directoryKey: string | null;
    negativeFilters: string | null;
    notificationMode: string;
    lastDigestAt: Date | null;
    scheduleMinutes: number; lastRunAt: Date | null; lastSuccessAt: Date | null;
    lastError: string | null; active: boolean;
    track: string;
    createdAt: Date; updatedAt: Date;
}) {
    let parsedFilters: string[] = [];
    if (w.negativeFilters) {
        try {
            const arr = JSON.parse(w.negativeFilters);
            if (Array.isArray(arr)) parsedFilters = arr.filter((x): x is string => typeof x === "string");
        } catch { /* malformed legacy row — surface empty */ }
    }
    // PB-14: hydrate from COMPANY_DIRECTORY when directoryKey is set. Failure
    // (malformed stored JSON without a recoverable directoryKey) drops the row
    // from the response instead of 500'ing the whole list — defense in depth
    // against schema drift / hand-edited DB rows.
    let hydrated;
    try {
        hydrated = hydrateWatchlistConfig({ config: w.config, directoryKey: w.directoryKey });
    } catch (e) {
        console.warn(`[watchlists serialize] dropping unparseable row ${w.id}:`, e instanceof Error ? e.message : e);
        return null;
    }
    return {
        ...w,
        // PB-14: top-level `kind` mirrors the hydrated config so clients never
        // see {kind: "greenhouse", config: {kind: "ashby"}} when a directory
        // entry switches ATS between crawls. The job-watcher syncs the column
        // itself on the next run, but the GET response shouldn't wait for it.
        kind: hydrated.kind,
        config: hydrated,
        directoryKey: w.directoryKey,
        negativeFilters: parsedFilters,
        lastDigestAt: w.lastDigestAt?.toISOString() ?? null,
        lastRunAt: w.lastRunAt?.toISOString() ?? null,
        lastSuccessAt: w.lastSuccessAt?.toISOString() ?? null,
        createdAt: w.createdAt.toISOString(),
        updatedAt: w.updatedAt.toISOString(),
    };
}

export async function GET(req: NextRequest) {
    const guard = await requireSession();
    if ('error' in guard) return guard.error;
    const userId = userIdFromGuard(guard);
    if (!userId) return NextResponse.json({ error: "Session missing user.id" }, { status: 401 });

    // MB Phase 4: optional ?track=career|side filter. Omitted = all tracks
    // (any unrecognized value also falls through to "all" rather than 400 —
    // matches the lenient ?status= filter convention elsewhere in this route).
    const trackParam = req.nextUrl.searchParams.get("track");
    const trackFilter = trackParam ? WatchlistTrackSchema.safeParse(trackParam) : null;
    const where: { userId: string; track?: string } = { userId };
    if (trackFilter?.success) where.track = trackFilter.data;

    try {
        const rows = await prisma.watchlist.findMany({
            where,
            orderBy: { createdAt: "asc" },
        });
        const out = rows.map(serialize).filter((x): x is Exclude<ReturnType<typeof serialize>, null> => x !== null);
        return NextResponse.json({ watchlists: out }, { status: 200 });
    } catch (e) {
        console.error("[watchlists GET] error:", e);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}

export async function POST(req: NextRequest) {
    const guard = await requireSession();
    if ('error' in guard) return guard.error;
    const userId = userIdFromGuard(guard);
    if (!userId) return NextResponse.json({ error: "Session missing user.id" }, { status: 401 });
    // Straight off the guard's synthesized session (lib/auth-guards.ts:45-56) —
    // no second identity lookup.
    const isOwner = guard.session.user.role === "owner";

    const parsed = WatchlistPostSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
        return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
    }

    // PB-14: if the client passed a directoryKey, let the directory entry
    // override the submitted config (defense against stale clients).
    const resolved = resolveCreatePayload(parsed.data.config, parsed.data.directoryKey ?? null);

    try {
        // P2.6.1 — cap crew BEFORE any other work. Checked ahead of the dedup
        // scan below because it is the cheaper query and the stronger rejection:
        // at the limit no request body can succeed, whereas "already watched" is
        // a fact about this particular one.
        if (!isOwner) {
            const owned = await prisma.watchlist.count({ where: { userId } });
            if (owned >= CREW_WATCHLIST_LIMIT) return limitReachedResponse(owned);
        }

        // Backstop dedup: block adding the same job board twice. The "Watch
        // company" picker already disables already-added directory entries
        // client-side (via watchlistConfigKey → an "Added" chip), but the
        // Advanced / Find-roles tabs can POST a raw config that collides — e.g.
        // the greenhouse "apex" board got added once as "Apex Space" and again
        // as "Apex", yielding two company badges + a duplicated feed row for
        // one board. watchlistConfigKey is null for keyword aggregators
        // (linkedin / indeed) and careers-page, so those overlap freely; only
        // board-identified ATS kinds are deduped. Identity is user-scoped and
        // track-agnostic — same as the modal's existingKeys.
        const newKey = watchlistConfigKey(resolved.config);
        if (newKey) {
            const existing = await prisma.watchlist.findMany({
                where: { userId },
                select: { id: true, name: true, config: true, directoryKey: true },
            });
            for (const w of existing) {
                let cfg;
                try {
                    cfg = hydrateWatchlistConfig({ config: w.config, directoryKey: w.directoryKey });
                } catch {
                    continue; // unparseable legacy row can't meaningfully collide
                }
                if (watchlistConfigKey(cfg) === newKey) {
                    return NextResponse.json(
                        { error: `That job board is already watched as "${w.name}".`, existingId: w.id },
                        { status: 409 },
                    );
                }
            }
        }

        // The pre-check above is a read-then-write, so two simultaneous POSTs
        // could both observe `owned = 4` and both create — landing a crew member
        // on 6. Re-assert the boundary INSIDE the write transaction so it holds
        // under concurrency: SQLite admits one writer at a time, and because the
        // INSERT is this transaction's first statement its read snapshot is
        // taken when the write lock is acquired — i.e. AFTER any transaction it
        // queued behind committed. So the second POST's `count()` sees the
        // first's row, exceeds the limit, and rolls its own insert back. (Order
        // matters: counting before inserting would reinstate the same TOCTOU
        // one level down, and could deadlock-by-snapshot on a WAL upgrade.)
        // Owner path skips the count entirely — one query, exactly as before.
        const row = await prisma.$transaction(async (tx) => {
            const created = await tx.watchlist.create({
                data: {
                    userId,
                    name: parsed.data.name,
                    kind: resolved.config.kind,
                    config: JSON.stringify(resolved.config),
                    directoryKey: resolved.directoryKey,
                    scheduleMinutes: parsed.data.scheduleMinutes,
                    notificationMode: parsed.data.notificationMode,
                    track: parsed.data.track,
                },
            });
            if (!isOwner) {
                const total = await tx.watchlist.count({ where: { userId } });
                // `total` includes the row we are about to roll back; report
                // what they actually keep.
                if (total > CREW_WATCHLIST_LIMIT) throw new WatchlistLimitExceeded(total - 1);
            }
            return created;
        });
        broadcastEvent({ model: 'Watchlist', action: 'upsert', id: row.id, userId, timestamp: Date.now() });

        // Kick off the first crawl in the background so the user gets postings
        // within seconds instead of waiting up to scheduleMinutes for the next
        // scheduler tick. Fire-and-forget — `runWatchlist` handles its own
        // errors + persists lastRunAt / lastError + broadcasts Watchlist +
        // Posting SSE events so the UI refreshes when it completes.
        runWatchlist(row.id).catch((err) =>
            console.warn(`[watchlists POST] initial runWatchlist failed for ${row.id}:`, err)
        );

        const serialized = serialize(row);
        if (!serialized) {
            // We just wrote this row — if hydration fails on the same payload
            // we accepted, that's a server-side bug. 500 (don't pretend success).
            console.error(`[watchlists POST] serialize returned null for fresh row ${row.id}`);
            return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
        }
        return NextResponse.json({ watchlist: serialized }, { status: 200 });
    } catch (e) {
        // The concurrent-create loser: a real rejection, not a server fault.
        // Must be translated before the 500 branch or the race would surface as
        // "Internal Server Error" for a request the user can act on.
        if (e instanceof WatchlistLimitExceeded) return limitReachedResponse(e.current);
        console.error("[watchlists POST] error:", e);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
