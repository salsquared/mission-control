import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth-guards";
import { broadcastEvent } from "@/lib/events";
import { WatchlistPostSchema } from "@/lib/schemas/watchlists";
import { hydrateWatchlistConfig, resolveCreatePayload } from "@/lib/watchlists/hydrate";
import { runWatchlist } from "@/scheduler/jobs/job-watcher";

export const runtime = "nodejs";

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
    lastError: string | null; active: boolean; createdAt: Date; updatedAt: Date;
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

export async function GET() {
    const guard = await requireSession();
    if ('error' in guard) return guard.error;
    const userId = userIdFromGuard(guard);
    if (!userId) return NextResponse.json({ error: "Session missing user.id" }, { status: 401 });

    try {
        const rows = await prisma.watchlist.findMany({
            where: { userId },
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

    const parsed = WatchlistPostSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
        return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
    }

    // PB-14: if the client passed a directoryKey, let the directory entry
    // override the submitted config (defense against stale clients).
    const resolved = resolveCreatePayload(parsed.data.config, parsed.data.directoryKey ?? null);

    try {
        const row = await prisma.watchlist.create({
            data: {
                userId,
                name: parsed.data.name,
                kind: resolved.config.kind,
                config: JSON.stringify(resolved.config),
                directoryKey: resolved.directoryKey,
                scheduleMinutes: parsed.data.scheduleMinutes,
                notificationMode: parsed.data.notificationMode,
            },
        });
        broadcastEvent({ model: 'Watchlist', action: 'upsert', id: row.id, timestamp: Date.now() });

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
        console.error("[watchlists POST] error:", e);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
