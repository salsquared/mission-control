import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guards";
import { broadcastEvent } from "@/lib/events";
import { ProfilePatchSchema } from "@/lib/schemas/profile";
import { findOrCreateProfile, updateProfileHeader } from "@/lib/repositories/profile";

export const runtime = "nodejs";

function userIdFromGuard(guard: { session: { user?: unknown } }): string | null {
    const user = guard.session.user as { id?: string } | undefined;
    return user?.id && user.id.length > 0 ? user.id : null;
}

export async function GET() {
    const guard = await requireSession();
    if ('error' in guard) return guard.error;
    const userId = userIdFromGuard(guard);
    if (!userId) return NextResponse.json({ error: "Session missing user.id" }, { status: 401 });

    try {
        const profile = await findOrCreateProfile(userId);
        return NextResponse.json({ profile }, { status: 200 });
    } catch (e) {
        console.error("[profile GET] error:", e);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}

export async function PATCH(req: NextRequest) {
    const guard = await requireSession();
    if ('error' in guard) return guard.error;
    const userId = userIdFromGuard(guard);
    if (!userId) return NextResponse.json({ error: "Session missing user.id" }, { status: 401 });

    const parsed = ProfilePatchSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
        return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
    }

    try {
        const profile = await updateProfileHeader(userId, parsed.data);
        broadcastEvent({ model: 'Profile', action: 'upsert', id: profile.id, timestamp: Date.now() });
        return NextResponse.json({ profile }, { status: 200 });
    } catch (e) {
        console.error("[profile PATCH] error:", e);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
