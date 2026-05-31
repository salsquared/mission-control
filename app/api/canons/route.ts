import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guards";
import { broadcastEvent } from "@/lib/events";
import { CanonPostSchema, CanonTrackSchema } from "@/lib/schemas/canons";
import { listCanons, createCanon } from "@/lib/repositories/canons";

export const runtime = "nodejs";

function userIdFromGuard(guard: { session: { user?: unknown } }): string | null {
    const user = guard.session.user as { id?: string } | undefined;
    return user?.id && user.id.length > 0 ? user.id : null;
}

// GET /api/canons[?track=career|side] — list the user's canons.
export async function GET(req: NextRequest) {
    const guard = await requireSession();
    if ("error" in guard) return guard.error;
    const userId = userIdFromGuard(guard);
    if (!userId) return NextResponse.json({ error: "Session missing user.id" }, { status: 401 });

    const trackParam = new URL(req.url).searchParams.get("track");
    const track = trackParam ? CanonTrackSchema.safeParse(trackParam) : null;
    try {
        const canons = await listCanons(userId, track?.success ? { track: track.data } : undefined);
        return NextResponse.json({ canons }, { status: 200 });
    } catch (e) {
        console.error("[canons GET] error:", e);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}

// POST /api/canons — create a canon. Slug is derived from name; a duplicate
// (userId, slug) returns 409.
export async function POST(req: NextRequest) {
    const guard = await requireSession();
    if ("error" in guard) return guard.error;
    const userId = userIdFromGuard(guard);
    if (!userId) return NextResponse.json({ error: "Session missing user.id" }, { status: 401 });

    const parsed = CanonPostSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
        return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
    }
    try {
        const canon = await createCanon(userId, parsed.data);
        broadcastEvent({ model: "Canon", action: "upsert", id: canon.id, timestamp: Date.now() });
        return NextResponse.json({ canon }, { status: 201 });
    } catch (e) {
        const code = (e as { code?: string } | null)?.code;
        if (code === "P2002") {
            return NextResponse.json(
                { error: "A canon with this name already exists." },
                { status: 409 },
            );
        }
        console.error("[canons POST] error:", e);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
