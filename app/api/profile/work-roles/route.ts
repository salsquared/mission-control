import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guards";
import { broadcastEvent } from "@/lib/events";
import {
    WorkRolePostSchema,
    WorkRolePatchSchema,
    ProfileChildDeleteSchema,
} from "@/lib/schemas/profile";
import {
    createWorkRole,
    updateWorkRole,
    deleteWorkRole,
} from "@/lib/repositories/profile";

export const runtime = "nodejs";

function userIdFromGuard(guard: { session: { user?: unknown } }): string | null {
    const user = guard.session.user as { id?: string } | undefined;
    return user?.id && user.id.length > 0 ? user.id : null;
}

export async function POST(req: NextRequest) {
    const guard = await requireSession();
    if ('error' in guard) return guard.error;
    const userId = userIdFromGuard(guard);
    if (!userId) return NextResponse.json({ error: "Session missing user.id" }, { status: 401 });

    const parsed = WorkRolePostSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
        return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
    }

    try {
        const workRole = await createWorkRole(userId, {
            company: parsed.data.company,
            title: parsed.data.title,
            location: parsed.data.location ?? null,
            startDate: new Date(parsed.data.startDate),
            endDate: parsed.data.endDate ? new Date(parsed.data.endDate) : null,
            bullets: parsed.data.bullets,
            position: parsed.data.position,
        });
        broadcastEvent({ model: 'Profile', action: 'upsert', id: workRole.id, timestamp: Date.now() });
        return NextResponse.json({ workRole }, { status: 200 });
    } catch (e) {
        console.error("[work-roles POST] error:", e);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}

export async function PATCH(req: NextRequest) {
    const guard = await requireSession();
    if ('error' in guard) return guard.error;
    const userId = userIdFromGuard(guard);
    if (!userId) return NextResponse.json({ error: "Session missing user.id" }, { status: 401 });

    const parsed = WorkRolePatchSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
        return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
    }

    try {
        const workRole = await updateWorkRole(userId, parsed.data.id, {
            company: parsed.data.company,
            title: parsed.data.title,
            location: parsed.data.location,
            startDate: parsed.data.startDate ? new Date(parsed.data.startDate) : undefined,
            endDate: parsed.data.endDate === undefined ? undefined : (parsed.data.endDate ? new Date(parsed.data.endDate) : null),
            bullets: parsed.data.bullets,
            position: parsed.data.position,
        });
        if (!workRole) return NextResponse.json({ error: "WorkRole not found" }, { status: 404 });
        broadcastEvent({ model: 'Profile', action: 'upsert', id: workRole.id, timestamp: Date.now() });
        return NextResponse.json({ workRole }, { status: 200 });
    } catch (e) {
        console.error("[work-roles PATCH] error:", e);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}

export async function DELETE(req: NextRequest) {
    const guard = await requireSession();
    if ('error' in guard) return guard.error;
    const userId = userIdFromGuard(guard);
    if (!userId) return NextResponse.json({ error: "Session missing user.id" }, { status: 401 });

    const url = new URL(req.url);
    const idParam = url.searchParams.get('id');
    const body = idParam ? { id: idParam } : await req.json().catch(() => ({}));
    const parsed = ProfileChildDeleteSchema.safeParse(body);
    if (!parsed.success) {
        return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
    }

    try {
        const ok = await deleteWorkRole(userId, parsed.data.id);
        if (!ok) return NextResponse.json({ error: "WorkRole not found" }, { status: 404 });
        broadcastEvent({ model: 'Profile', action: 'delete', id: parsed.data.id, timestamp: Date.now() });
        return NextResponse.json({ success: true, id: parsed.data.id }, { status: 200 });
    } catch (e) {
        console.error("[work-roles DELETE] error:", e);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
