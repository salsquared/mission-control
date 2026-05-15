import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth-guards";
import { broadcastEvent } from "@/lib/events";

export const runtime = "nodejs";

function userIdFromGuard(guard: { session: { user?: unknown } }): string | null {
    const user = guard.session.user as { id?: string } | undefined;
    return user?.id && user.id.length > 0 ? user.id : null;
}

/**
 * Story 20: convert a tracked posting into a draft Application.
 *
 *   POST /api/postings/[id]/track-as-application
 *
 * Idempotent: if an Application already exists with `postingId = <id>`, the
 * existing row is returned and the posting is left in whatever status it was.
 * Otherwise creates an Application with status='INTERESTED' + posting's
 * company/role, links them via Application.postingId, and flips the posting
 * to status='tracked'.
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const guard = await requireSession();
    if ('error' in guard) return guard.error;
    const userId = userIdFromGuard(guard);
    if (!userId) return NextResponse.json({ error: "Session missing user.id" }, { status: 401 });

    const { id } = await params;

    const posting = await prisma.jobPosting.findFirst({
        where: { id, watchlist: { userId } },
        select: { id: true, company: true, title: true, status: true },
    });
    if (!posting) {
        return NextResponse.json({ error: "Posting not found" }, { status: 404 });
    }

    try {
        // Defensive: include userId so a future cross-user posting share can't
        // leak somebody else's Application via the unique-key shortcut. Today
        // ownership is enforced transitively via watchlist.user above.
        const existing = await prisma.application.findFirst({ where: { postingId: posting.id, userId } });
        if (existing) {
            return NextResponse.json({
                application: existing,
                posting: { id: posting.id, status: posting.status },
                created: false,
            }, { status: 200 });
        }

        const now = new Date();
        const result = await prisma.$transaction(async (tx) => {
            const application = await tx.application.create({
                data: {
                    userId,
                    company: posting.company,
                    role: posting.title,
                    status: "INTERESTED",
                    kind: "job",
                    postingId: posting.id,
                    lastUpdateAt: now,
                },
            });
            const updatedPosting = await tx.jobPosting.update({
                where: { id: posting.id },
                data: { status: "tracked" },
                select: { id: true, status: true },
            });
            return { application, posting: updatedPosting };
        });

        broadcastEvent({ model: 'Application', action: 'upsert', id: result.application.id, timestamp: Date.now() });
        broadcastEvent({ model: 'Posting', action: 'upsert', id: result.posting.id, timestamp: Date.now() });

        return NextResponse.json({
            application: result.application,
            posting: result.posting,
            created: true,
        }, { status: 200 });
    } catch (e) {
        console.error(`[postings/${id}/track-as-application] error:`, e);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
