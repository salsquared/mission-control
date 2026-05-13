import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth-guards";
import { broadcastEvent } from "@/lib/events";
import {
    ApplicationPostSchema,
    ApplicationPatchSchema,
    ApplicationDeleteSchema,
} from "@/lib/schemas/applications";
import {
    findApplicationsByUser,
    findApplicationByIdForUser,
    createApplication,
    updateApplication,
    deleteApplication,
    type ApplicationUpdate,
} from "@/lib/repositories/applications";

export const runtime = "nodejs";

function userIdFromGuard(guard: { session: { user?: unknown } }): string | null {
    const user = guard.session.user as { id?: string } | undefined;
    const id = user?.id;
    return typeof id === "string" && id.length > 0 ? id : null;
}

export async function GET() {
    const guard = await requireSession();
    if ('error' in guard) return guard.error;
    const userId = userIdFromGuard(guard);
    if (!userId) return NextResponse.json({ error: "Session missing user.id" }, { status: 401 });

    try {
        const applications = await findApplicationsByUser(userId);
        return NextResponse.json({ applications }, { status: 200 });
    } catch (e: any) {
        console.error("[applications GET] error:", e);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}

export async function POST(req: NextRequest) {
    const guard = await requireSession();
    if ('error' in guard) return guard.error;
    const userId = userIdFromGuard(guard);
    if (!userId) return NextResponse.json({ error: "Session missing user.id" }, { status: 401 });

    const parsed = ApplicationPostSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
        return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
    }
    const { company, role, status, kind, nextSteps, dateApplied } = parsed.data;
    const now = new Date();

    try {
        const application = await createApplication({
            userId,
            company,
            role: role ?? '',
            status,
            kind: kind ?? null,
            nextSteps: nextSteps ?? null,
            dateApplied: dateApplied ? new Date(dateApplied) : undefined,
            lastUpdateAt: now,
        });

        // If the caller provided a dateApplied, record an APPLIED event so the
        // timeline starts populated. Without dateApplied we leave the timeline
        // empty until the user adds notes or status changes.
        if (dateApplied) {
            await prisma.applicationEvent.create({
                data: {
                    applicationId: application.id,
                    kind: 'APPLIED',
                    title: `Applied to ${company}`,
                    occurredAt: new Date(dateApplied),
                    syncSource: 'ms',
                },
            });
        }

        broadcastEvent({ model: 'Application', action: 'upsert', id: application.id, timestamp: Date.now() });
        return NextResponse.json({ application }, { status: 200 });
    } catch (e: any) {
        console.error("[applications POST] error:", e);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}

export async function PATCH(req: NextRequest) {
    const guard = await requireSession();
    if ('error' in guard) return guard.error;
    const userId = userIdFromGuard(guard);
    if (!userId) return NextResponse.json({ error: "Session missing user.id" }, { status: 401 });

    const parsed = ApplicationPatchSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
        return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
    }
    const { id, company, role, status, kind, nextSteps, dateApplied } = parsed.data;

    try {
        const existing = await findApplicationByIdForUser(id, userId);
        if (!existing) {
            return NextResponse.json({ error: "Application not found" }, { status: 404 });
        }

        const update: ApplicationUpdate = { lastUpdateAt: new Date() };
        if (company !== undefined) update.company = company;
        if (role !== undefined) update.role = role;
        if (status !== undefined) update.status = status;
        if (kind !== undefined) update.kind = kind;
        if (nextSteps !== undefined) update.nextSteps = nextSteps;
        if (dateApplied !== undefined) update.dateApplied = dateApplied ? new Date(dateApplied) : null;

        const application = await updateApplication(id, update);

        // If status moved, record a STATUS_CHANGED event so the timeline
        // captures it. Notes/dates/role changes are intentionally not echoed
        // as timeline rows — they're metadata, not events.
        if (status !== undefined && status !== existing.status) {
            await prisma.applicationEvent.create({
                data: {
                    applicationId: id,
                    kind: 'STATUS_CHANGED',
                    title: `Status: ${existing.status} → ${status}`,
                    occurredAt: new Date(),
                    fromStatus: existing.status,
                    toStatus: status,
                    syncSource: 'ms',
                },
            });
        }

        broadcastEvent({ model: 'Application', action: 'upsert', id, timestamp: Date.now() });
        return NextResponse.json({ application }, { status: 200 });
    } catch (e: any) {
        console.error("[applications PATCH] error:", e);
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
    const parsed = ApplicationDeleteSchema.safeParse(body);
    if (!parsed.success) {
        return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
    }
    const { id } = parsed.data;

    try {
        const existing = await findApplicationByIdForUser(id, userId);
        if (!existing) {
            return NextResponse.json({ error: "Application not found" }, { status: 404 });
        }
        await deleteApplication(id);

        broadcastEvent({ model: 'Application', action: 'delete', id, timestamp: Date.now() });
        return NextResponse.json({ success: true, id }, { status: 200 });
    } catch (e: any) {
        console.error("[applications DELETE] error:", e);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
