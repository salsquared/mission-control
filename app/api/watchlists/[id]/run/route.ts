import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth-guards";
import { runWatchlist } from "@/scheduler/jobs/job-watcher";

export const runtime = "nodejs";
// Crawling an external URL + DB writes can be slow on big careers pages.
export const maxDuration = 30;

function userIdFromGuard(guard: { session: { user?: unknown } }): string | null {
    const user = guard.session.user as { id?: string } | undefined;
    return user?.id && user.id.length > 0 ? user.id : null;
}

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const guard = await requireSession();
    if ('error' in guard) return guard.error;
    const userId = userIdFromGuard(guard);
    if (!userId) return NextResponse.json({ error: "Session missing user.id" }, { status: 401 });

    const { id } = await params;
    const owned = await prisma.watchlist.findFirst({ where: { id, userId }, select: { id: true } });
    if (!owned) {
        return NextResponse.json({ error: "Watchlist not found" }, { status: 404 });
    }

    try {
        const result = await runWatchlist(id);
        return NextResponse.json(result, { status: result.error ? 502 : 200 });
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[watchlists/${id}/run] error:`, e);
        return NextResponse.json({ watchlistId: id, newPostings: 0, seenAgain: 0, error: msg }, { status: 500 });
    }
}
