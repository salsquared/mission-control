import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guards";
import { broadcastEvent } from "@/lib/events";
import { CanonSelectionPutSchema } from "@/lib/schemas/canons";
import { getCanon, getCanonSelection, saveCanonSelection } from "@/lib/repositories/canons";

export const runtime = "nodejs";

// The manual builder's per-Canon selection (docs/archive/resume-manual-builder.html, P2.1).
// GET loads the saved selection (null when not yet curated — the builder then
// pre-fills from the last resume / opens empty). PUT replaces it wholesale.

function userIdFromGuard(guard: { session: { user?: unknown } }): string | null {
    const user = guard.session.user as { id?: string } | undefined;
    return user?.id && user.id.length > 0 ? user.id : null;
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const guard = await requireSession();
    if ("error" in guard) return guard.error;
    const userId = userIdFromGuard(guard);
    if (!userId) return NextResponse.json({ error: "Session missing user.id" }, { status: 401 });

    const { id } = await params;
    try {
        const canon = await getCanon(userId, id);
        if (!canon) return NextResponse.json({ error: "Canon not found" }, { status: 404 });
        const selection = await getCanonSelection(userId, id);
        return NextResponse.json({ selection }, { status: 200 });
    } catch (e) {
        console.error(`[canons/${id}/selection GET] error:`, e);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const guard = await requireSession();
    if ("error" in guard) return guard.error;
    const userId = userIdFromGuard(guard);
    if (!userId) return NextResponse.json({ error: "Session missing user.id" }, { status: 401 });

    const { id } = await params;
    const parsed = CanonSelectionPutSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
        return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
    }
    try {
        const ok = await saveCanonSelection(userId, id, parsed.data);
        if (!ok) return NextResponse.json({ error: "Canon not found" }, { status: 404 });
        broadcastEvent({ model: "Canon", action: "upsert", id, timestamp: Date.now() });
        return NextResponse.json({ ok: true }, { status: 200 });
    } catch (e) {
        console.error(`[canons/${id}/selection PUT] error:`, e);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
