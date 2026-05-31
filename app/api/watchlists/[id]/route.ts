import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth-guards";
import { broadcastEvent } from "@/lib/events";
import { WatchlistPatchSchema } from "@/lib/schemas/watchlists";
import { hydrateWatchlistConfig } from "@/lib/watchlists/hydrate";

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
    let hydrated;
    try {
        hydrated = hydrateWatchlistConfig({ config: w.config, directoryKey: w.directoryKey });
    } catch (e) {
        console.warn(`[watchlists/${w.id} serialize] hydration failed:`, e instanceof Error ? e.message : e);
        return null;
    }
    return {
        ...w,
        // PB-14: top-level `kind` mirrors hydrated config (see route.ts).
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

async function ownedWatchlist(userId: string, id: string) {
    return prisma.watchlist.findFirst({ where: { id, userId } });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const guard = await requireSession();
    if ('error' in guard) return guard.error;
    const userId = userIdFromGuard(guard);
    if (!userId) return NextResponse.json({ error: "Session missing user.id" }, { status: 401 });

    const { id } = await params;
    if (!await ownedWatchlist(userId, id)) {
        return NextResponse.json({ error: "Watchlist not found" }, { status: 404 });
    }

    const parsed = WatchlistPatchSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
        return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
    }
    // §6 Q4 — verify a non-null canon link belongs to this user.
    if (parsed.data.canonId) {
        const ownCanon = await prisma.canon.findFirst({ where: { id: parsed.data.canonId, userId }, select: { id: true } });
        if (!ownCanon) {
            return NextResponse.json({ error: "Canon not found" }, { status: 400 });
        }
    }

    try {
        const data: Record<string, unknown> = {};
        if (parsed.data.name !== undefined) data.name = parsed.data.name;
        if (parsed.data.config !== undefined) {
            data.config = JSON.stringify(parsed.data.config);
            // Keep the denormalized kind column in sync with config.kind.
            data.kind = parsed.data.config.kind;
            // PB-14: a manual config PATCH detaches the row from the directory.
            // Otherwise the next read would re-hydrate from the directory and
            // throw away the user's override.
            data.directoryKey = null;
        }
        if (parsed.data.scheduleMinutes !== undefined) data.scheduleMinutes = parsed.data.scheduleMinutes;
        if (parsed.data.active !== undefined) data.active = parsed.data.active;
        if (parsed.data.notificationMode !== undefined) data.notificationMode = parsed.data.notificationMode;
        if (parsed.data.track !== undefined) data.track = parsed.data.track;
        if (parsed.data.canonId !== undefined) data.canonId = parsed.data.canonId;
        if (parsed.data.negativeFilters !== undefined) {
            // Empty array → NULL so the column reads as "no filtering" rather than "[]".
            data.negativeFilters = parsed.data.negativeFilters.length > 0
                ? JSON.stringify(parsed.data.negativeFilters)
                : null;
        }

        const row = await prisma.watchlist.update({ where: { id }, data });
        broadcastEvent({ model: 'Watchlist', action: 'upsert', id: row.id, timestamp: Date.now() });
        const serialized = serialize(row);
        if (!serialized) {
            console.error(`[watchlists/${id} PATCH] serialize returned null after our own update`);
            return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
        }
        return NextResponse.json({ watchlist: serialized }, { status: 200 });
    } catch (e) {
        console.error(`[watchlists/${id} PATCH] error:`, e);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const guard = await requireSession();
    if ('error' in guard) return guard.error;
    const userId = userIdFromGuard(guard);
    if (!userId) return NextResponse.json({ error: "Session missing user.id" }, { status: 401 });

    const { id } = await params;
    if (!await ownedWatchlist(userId, id)) {
        return NextResponse.json({ error: "Watchlist not found" }, { status: 404 });
    }

    try {
        await prisma.watchlist.delete({ where: { id } });
        broadcastEvent({ model: 'Watchlist', action: 'delete', id, timestamp: Date.now() });
        return NextResponse.json({ success: true, id }, { status: 200 });
    } catch (e) {
        console.error(`[watchlists/${id} DELETE] error:`, e);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
