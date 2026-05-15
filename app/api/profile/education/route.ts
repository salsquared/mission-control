import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guards";
import { broadcastEvent } from "@/lib/events";
import {
    EducationPostSchema,
    EducationPatchSchema,
    ProfileChildDeleteSchema,
} from "@/lib/schemas/profile";
import { createEducation, updateEducation, deleteEducation } from "@/lib/repositories/profile";

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

    const parsed = EducationPostSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
        return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
    }

    try {
        const education = await createEducation(userId, {
            institution: parsed.data.institution,
            degree: parsed.data.degree ?? null,
            field: parsed.data.field ?? null,
            startDate: parsed.data.startDate ? new Date(parsed.data.startDate) : null,
            endDate: parsed.data.endDate ? new Date(parsed.data.endDate) : null,
            bullets: parsed.data.bullets,
            position: parsed.data.position,
        });
        broadcastEvent({ model: 'Profile', action: 'upsert', id: education.id, timestamp: Date.now() });
        return NextResponse.json({ education }, { status: 200 });
    } catch (e) {
        console.error("[education POST] error:", e);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}

export async function PATCH(req: NextRequest) {
    const guard = await requireSession();
    if ('error' in guard) return guard.error;
    const userId = userIdFromGuard(guard);
    if (!userId) return NextResponse.json({ error: "Session missing user.id" }, { status: 401 });

    const parsed = EducationPatchSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
        return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
    }

    try {
        const education = await updateEducation(userId, parsed.data.id, {
            institution: parsed.data.institution,
            degree: parsed.data.degree,
            field: parsed.data.field,
            startDate: parsed.data.startDate === undefined ? undefined : (parsed.data.startDate ? new Date(parsed.data.startDate) : null),
            endDate: parsed.data.endDate === undefined ? undefined : (parsed.data.endDate ? new Date(parsed.data.endDate) : null),
            bullets: parsed.data.bullets,
            position: parsed.data.position,
        });
        if (!education) return NextResponse.json({ error: "Education not found" }, { status: 404 });
        broadcastEvent({ model: 'Profile', action: 'upsert', id: education.id, timestamp: Date.now() });
        return NextResponse.json({ education }, { status: 200 });
    } catch (e) {
        console.error("[education PATCH] error:", e);
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
        const ok = await deleteEducation(userId, parsed.data.id);
        if (!ok) return NextResponse.json({ error: "Education not found" }, { status: 404 });
        broadcastEvent({ model: 'Profile', action: 'delete', id: parsed.data.id, timestamp: Date.now() });
        return NextResponse.json({ success: true, id: parsed.data.id }, { status: 200 });
    } catch (e) {
        console.error("[education DELETE] error:", e);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
