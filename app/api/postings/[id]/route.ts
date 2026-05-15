import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth-guards";
import { broadcastEvent } from "@/lib/events";
import { JobPostingPatchSchema } from "@/lib/schemas/watchlists";

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

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const guard = await requireSession();
    if ('error' in guard) return guard.error;
    const userId = userIdFromGuard(guard);
    if (!userId) return NextResponse.json({ error: "Session missing user.id" }, { status: 401 });

    const { id } = await params;
    const owned = await prisma.jobPosting.findFirst({
        where: { id, watchlist: { userId } },
        select: { id: true },
    });
    if (!owned) {
        return NextResponse.json({ error: "Posting not found" }, { status: 404 });
    }

    const parsed = JobPostingPatchSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
        return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
    }

    try {
        const row = await prisma.jobPosting.update({
            where: { id },
            data: { status: parsed.data.status },
        });
        broadcastEvent({ model: 'Posting', action: 'upsert', id: row.id, timestamp: Date.now() });
        return NextResponse.json({ posting: serialize(row) }, { status: 200 });
    } catch (e) {
        console.error(`[postings/${id} PATCH] error:`, e);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
