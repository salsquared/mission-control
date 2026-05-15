import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth-guards";
import { JobPostingStatusSchema } from "@/lib/schemas/watchlists";

export const runtime = "nodejs";

function userIdFromGuard(guard: { session: { user?: unknown } }): string | null {
    const user = guard.session.user as { id?: string } | undefined;
    return user?.id && user.id.length > 0 ? user.id : null;
}

function serialize(p: {
    id: string; watchlistId: string; externalId: string; company: string;
    title: string; location: string | null; postedAt: Date | null; snippet: string | null;
    sourceUrl: string; status: string; firstSeenAt: Date; lastSeenAt: Date;
    removedAt: Date | null;
}) {
    return {
        id: p.id,
        watchlistId: p.watchlistId,
        externalId: p.externalId,
        company: p.company,
        title: p.title,
        location: p.location,
        postedAt: p.postedAt?.toISOString() ?? null,
        snippet: p.snippet,
        sourceUrl: p.sourceUrl,
        status: p.status,
        firstSeenAt: p.firstSeenAt.toISOString(),
        lastSeenAt: p.lastSeenAt.toISOString(),
        removedAt: p.removedAt?.toISOString() ?? null,
    };
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export async function GET(req: NextRequest) {
    const guard = await requireSession();
    if ('error' in guard) return guard.error;
    const userId = userIdFromGuard(guard);
    if (!userId) return NextResponse.json({ error: "Session missing user.id" }, { status: 401 });

    const url = new URL(req.url);
    const statusParam = url.searchParams.get("status");
    const watchlistId = url.searchParams.get("watchlistId");
    const limitRaw = Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(1, Math.floor(limitRaw)), MAX_LIMIT) : DEFAULT_LIMIT;

    const where: Record<string, unknown> = { watchlist: { userId } };
    if (statusParam) {
        const s = JobPostingStatusSchema.safeParse(statusParam);
        if (!s.success) return NextResponse.json({ error: "Invalid status filter" }, { status: 400 });
        where.status = s.data;
    }
    if (watchlistId) {
        // ownership of the watchlist is enforced transitively by the user join above
        where.watchlistId = watchlistId;
    }

    try {
        const rows = await prisma.jobPosting.findMany({
            where,
            orderBy: { lastSeenAt: "desc" },
            take: limit,
        });
        return NextResponse.json({ postings: rows.map(serialize) }, { status: 200 });
    } catch (e) {
        console.error("[postings GET] error:", e);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
