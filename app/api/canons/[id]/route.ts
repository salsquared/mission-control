import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guards";
import { broadcastEvent } from "@/lib/events";
import { CanonPatchSchema } from "@/lib/schemas/canons";
import { getCanon, updateCanon, deleteCanon } from "@/lib/repositories/canons";

export const runtime = "nodejs";

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
        return NextResponse.json({ canon }, { status: 200 });
    } catch (e) {
        console.error(`[canons/${id} GET] error:`, e);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const guard = await requireSession();
    if ("error" in guard) return guard.error;
    const userId = userIdFromGuard(guard);
    if (!userId) return NextResponse.json({ error: "Session missing user.id" }, { status: 401 });

    const { id } = await params;
    const parsed = CanonPatchSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
        return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
    }
    try {
        const canon = await updateCanon(userId, id, parsed.data);
        if (!canon) return NextResponse.json({ error: "Canon not found" }, { status: 404 });
        broadcastEvent({ model: "Canon", action: "upsert", id, timestamp: Date.now() });
        return NextResponse.json({ canon }, { status: 200 });
    } catch (e) {
        const code = (e as { code?: string } | null)?.code;
        if (code === "P2002") {
            return NextResponse.json(
                { error: "A canon with this name already exists." },
                { status: 409 },
            );
        }
        console.error(`[canons/${id} PATCH] error:`, e);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const guard = await requireSession();
    if ("error" in guard) return guard.error;
    const userId = userIdFromGuard(guard);
    if (!userId) return NextResponse.json({ error: "Session missing user.id" }, { status: 401 });

    const { id } = await params;
    try {
        const ok = await deleteCanon(userId, id);
        if (!ok) return NextResponse.json({ error: "Canon not found" }, { status: 404 });
        broadcastEvent({ model: "Canon", action: "delete", id, timestamp: Date.now() });
        return NextResponse.json({ ok: true }, { status: 200 });
    } catch (e) {
        console.error(`[canons/${id} DELETE] error:`, e);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
