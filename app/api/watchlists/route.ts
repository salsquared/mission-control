import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth-guards";
import { broadcastEvent } from "@/lib/events";
import { WatchlistPostSchema } from "@/lib/schemas/watchlists";

export const runtime = "nodejs";

function userIdFromGuard(guard: { session: { user?: unknown } }): string | null {
    const user = guard.session.user as { id?: string } | undefined;
    return user?.id && user.id.length > 0 ? user.id : null;
}

function serialize(w: {
    id: string; userId: string; name: string; kind: string; config: string;
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
    return {
        ...w,
        config: JSON.parse(w.config),
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
        return NextResponse.json({ watchlists: rows.map(serialize) }, { status: 200 });
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

    try {
        const row = await prisma.watchlist.create({
            data: {
                userId,
                name: parsed.data.name,
                kind: parsed.data.config.kind,
                config: JSON.stringify(parsed.data.config),
                scheduleMinutes: parsed.data.scheduleMinutes,
                notificationMode: parsed.data.notificationMode,
            },
        });
        broadcastEvent({ model: 'Watchlist', action: 'upsert', id: row.id, timestamp: Date.now() });
        return NextResponse.json({ watchlist: serialize(row) }, { status: 200 });
    } catch (e) {
        console.error("[watchlists POST] error:", e);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
