import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guards";
import { broadcastEvent } from "@/lib/events";
import { ProfileSnapshotPostSchema } from "@/lib/schemas/profile";
import {
    createProfileSnapshot,
    listProfileSnapshots,
} from "@/lib/repositories/profile-snapshots";

export const runtime = "nodejs";

function userIdFromGuard(guard: { session: { user?: unknown } }): string | null {
    const user = guard.session.user as { id?: string } | undefined;
    return user?.id && user.id.length > 0 ? user.id : null;
}

function serializeSummary(row: { id: string; takenAt: Date; label: string | null }) {
    return { id: row.id, takenAt: row.takenAt.toISOString(), label: row.label };
}

export async function GET() {
    const guard = await requireSession();
    if ('error' in guard) return guard.error;
    const userId = userIdFromGuard(guard);
    if (!userId) return NextResponse.json({ error: "Session missing user.id" }, { status: 401 });

    try {
        const rows = await listProfileSnapshots(userId);
        return NextResponse.json({ snapshots: rows.map(serializeSummary) }, { status: 200 });
    } catch (e) {
        console.error("[profile/snapshots GET] error:", e);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}

export async function POST(req: NextRequest) {
    const guard = await requireSession();
    if ('error' in guard) return guard.error;
    const userId = userIdFromGuard(guard);
    if (!userId) return NextResponse.json({ error: "Session missing user.id" }, { status: 401 });

    const parsed = ProfileSnapshotPostSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
        return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
    }

    try {
        const snapshot = await createProfileSnapshot(userId, parsed.data.label ?? null);
        broadcastEvent({ model: 'ProfileSnapshot', action: 'upsert', id: snapshot.id, timestamp: Date.now() });
        return NextResponse.json({ snapshot: serializeSummary(snapshot) }, { status: 200 });
    } catch (e) {
        console.error("[profile/snapshots POST] error:", e);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
