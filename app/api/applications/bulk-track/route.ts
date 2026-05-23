import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guards";
import { broadcastEvent } from "@/lib/events";
import { ApplicationBulkTrackSchema } from "@/lib/schemas/applications";
import { bulkMoveApplicationsTrack } from "@/lib/repositories/applications";

export const runtime = "nodejs";

function userIdFromGuard(guard: { session: { user?: unknown } }): string | null {
    const user = guard.session.user as { id?: string } | undefined;
    return user?.id && user.id.length > 0 ? user.id : null;
}

// Story 63 — bulk move N applications between tracks in one round-trip.
// Atomic per the underlying $transaction: either every row moves or none do
// (conflicts return 409 with the offending pairs, no partial state). Cross-
// user ids in the input list silently drop — they don't error and they don't
// move. The response counts only the rows that actually changed track.
export async function POST(req: NextRequest) {
    const guard = await requireSession();
    if ('error' in guard) return guard.error;
    const userId = userIdFromGuard(guard);
    if (!userId) return NextResponse.json({ error: "Session missing user.id" }, { status: 401 });

    const parsed = ApplicationBulkTrackSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
        return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
    }

    try {
        const result = await bulkMoveApplicationsTrack(userId, parsed.data.ids, parsed.data.track);
        if (result.conflicts.length > 0) {
            return NextResponse.json(
                { error: "conflict", conflicts: result.conflicts },
                { status: 409 },
            );
        }
        // One SSE event per moved row so per-track caches (career + side) on
        // the same browser tab both invalidate. ApplicationsView already keys
        // on a predicate match for 'applications' so this fans out cleanly.
        for (const id of result.ids) {
            broadcastEvent({ model: 'Application', action: 'upsert', id, timestamp: Date.now() });
        }
        return NextResponse.json({ updated: result.updated, ids: result.ids }, { status: 200 });
    } catch (e) {
        console.error("[applications/bulk-track POST] error:", e);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
