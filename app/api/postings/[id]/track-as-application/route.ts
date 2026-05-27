import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guards";
import { prisma } from "@/lib/prisma";
import { trackAsApplication } from "@/lib/postings/track-as-application";

export const runtime = "nodejs";

function userIdFromGuard(guard: { session: { user?: unknown } }): string | null {
    const user = guard.session.user as { id?: string } | undefined;
    return user?.id && user.id.length > 0 ? user.id : null;
}

// Story S5.5: convert a tracked posting into a draft Application.
//
//   POST /api/postings/[id]/track-as-application
//
// Auth wrapper; the actual work lives in lib/postings/track-as-application.ts
// so the hermetic smoke can call it without a session.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const guard = await requireSession();
    if ('error' in guard) return guard.error;
    const userId = userIdFromGuard(guard);
    if (!userId) return NextResponse.json({ error: "Session missing user.id" }, { status: 401 });

    const { id } = await params;

    try {
        const result = await trackAsApplication(userId, id);
        if (!result.ok) {
            return NextResponse.json({ error: "Posting not found" }, { status: 404 });
        }
        // The UI consumes application + posting + created. Hydrate the
        // application row here so the client gets the full shape.
        const application = await prisma.application.findUnique({ where: { id: result.applicationId } });
        return NextResponse.json({
            application,
            posting: { id, status: result.postingStatus },
            created: result.created,
            merged: result.merged,
        }, { status: 200 });
    } catch (e) {
        console.error(`[postings/${id}/track-as-application] error:`, e);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
