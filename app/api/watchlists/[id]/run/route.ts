import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth-guards";
import { consumeAiCredit, aiQuotaExceededResponse } from "@/lib/ai/quota";
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

    // P2.5.2 — per-user daily Gemini credit (lib/ai/quota.ts). Owner exempt.
    // runWatchlist classifies employment types through Gemini. Placed AFTER the
    // ownership check so a 404 never burns a credit.
    //
    // MANUAL runs only. The SAME runWatchlist on the scheduler's automatic
    // cadence is deliberately outside this cap in v1 (§2.9's callout, R6) —
    // that path never reaches a route, so it never reaches this line. See the
    // header of lib/ai/quota.ts before "fixing" that asymmetry.
    const credit = await consumeAiCredit(userId, guard.session.user.role);
    if (!credit.ok) return aiQuotaExceededResponse(credit);

    try {
        const result = await runWatchlist(id);
        return NextResponse.json(result, { status: result.error ? 502 : 200 });
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[watchlists/${id}/run] error:`, e);
        return NextResponse.json({ watchlistId: id, newPostings: 0, seenAgain: 0, closed: 0, error: msg }, { status: 500 });
    }
}
