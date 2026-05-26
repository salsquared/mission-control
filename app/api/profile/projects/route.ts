import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guards";
import { broadcastEvent } from "@/lib/events";
import {
    ProjectPostSchema,
    ProjectPatchSchema,
    ProfileChildDeleteSchema,
} from "@/lib/schemas/profile";
import { createProject, updateProject, deleteProject } from "@/lib/repositories/profile";

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

    const parsed = ProjectPostSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
        return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
    }

    try {
        const project = await createProject(userId, {
            name: parsed.data.name,
            description: parsed.data.description ?? null,
            repoUrl: parsed.data.repoUrl ?? null,
            liveUrl: parsed.data.liveUrl ?? null,
            bullets: parsed.data.bullets,
            githubRepo: parsed.data.githubRepo ?? null,
            portfolio: parsed.data.portfolio,
            scratchpad: parsed.data.scratchpad ?? null,
            position: parsed.data.position,
        });
        broadcastEvent({ model: 'Profile', action: 'upsert', id: project.id, timestamp: Date.now() });
        return NextResponse.json({ project }, { status: 200 });
    } catch (e) {
        console.error("[projects POST] error:", e);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}

export async function PATCH(req: NextRequest) {
    const guard = await requireSession();
    if ('error' in guard) return guard.error;
    const userId = userIdFromGuard(guard);
    if (!userId) return NextResponse.json({ error: "Session missing user.id" }, { status: 401 });

    const parsed = ProjectPatchSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
        return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
    }

    try {
        const project = await updateProject(userId, parsed.data.id, {
            name: parsed.data.name,
            description: parsed.data.description,
            repoUrl: parsed.data.repoUrl,
            liveUrl: parsed.data.liveUrl,
            bullets: parsed.data.bullets,
            githubRepo: parsed.data.githubRepo,
            portfolio: parsed.data.portfolio,
            scratchpad: parsed.data.scratchpad,
            position: parsed.data.position,
        });
        if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
        broadcastEvent({ model: 'Profile', action: 'upsert', id: project.id, timestamp: Date.now() });
        return NextResponse.json({ project }, { status: 200 });
    } catch (e) {
        console.error("[projects PATCH] error:", e);
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
        const ok = await deleteProject(userId, parsed.data.id);
        if (!ok) return NextResponse.json({ error: "Project not found" }, { status: 404 });
        broadcastEvent({ model: 'Profile', action: 'delete', id: parsed.data.id, timestamp: Date.now() });
        return NextResponse.json({ success: true, id: parsed.data.id }, { status: 200 });
    } catch (e) {
        console.error("[projects DELETE] error:", e);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
