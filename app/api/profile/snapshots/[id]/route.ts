import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guards";
import { broadcastEvent } from "@/lib/events";
import {
    deleteProfileSnapshot,
    getProfileSnapshot,
} from "@/lib/repositories/profile-snapshots";
import type { HydratedProfile } from "@/lib/repositories/profile";

export const runtime = "nodejs";

function userIdFromGuard(guard: { session: { user?: unknown } }): string | null {
    const user = guard.session.user as { id?: string } | undefined;
    return user?.id && user.id.length > 0 ? user.id : null;
}

// The stored payload was hydrated when written, so JSON.parse reconstructs
// the Bullet[] arrays directly — no extra walk needed. We only have to coerce
// the takenAt Date back to an ISO string for the wire response.
function serializeForWire(snapshot: {
    id: string;
    takenAt: Date;
    label: string | null;
    payload: HydratedProfile;
}) {
    return {
        id: snapshot.id,
        takenAt: snapshot.takenAt.toISOString(),
        label: snapshot.label,
        payload: snapshot.payload,
    };
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const guard = await requireSession();
    if ('error' in guard) return guard.error;
    const userId = userIdFromGuard(guard);
    if (!userId) return NextResponse.json({ error: "Session missing user.id" }, { status: 401 });

    const { id } = await params;

    try {
        const snapshot = await getProfileSnapshot(userId, id);
        if (!snapshot) return NextResponse.json({ error: "Snapshot not found" }, { status: 404 });
        return NextResponse.json({ snapshot: serializeForWire(snapshot) }, { status: 200 });
    } catch (e) {
        console.error("[profile/snapshots/[id] GET] error:", e);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const guard = await requireSession();
    if ('error' in guard) return guard.error;
    const userId = userIdFromGuard(guard);
    if (!userId) return NextResponse.json({ error: "Session missing user.id" }, { status: 401 });

    const { id } = await params;

    try {
        const ok = await deleteProfileSnapshot(userId, id);
        if (!ok) return NextResponse.json({ error: "Snapshot not found" }, { status: 404 });
        broadcastEvent({ model: 'ProfileSnapshot', action: 'delete', id, timestamp: Date.now() });
        return NextResponse.json({ success: true, id }, { status: 200 });
    } catch (e) {
        console.error("[profile/snapshots/[id] DELETE] error:", e);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
