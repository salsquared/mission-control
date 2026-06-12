import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth-guards";
import { broadcastEvent } from "@/lib/events";
import {
    ApplicationPostSchema,
    ApplicationPatchSchema,
    ApplicationDeleteSchema,
    ApplicationTrackSchema,
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

export async function GET(req: NextRequest) {
    const guard = await requireSession();
    if ('error' in guard) return guard.error;
    const userId = userIdFromGuard(guard);
    if (!userId) return NextResponse.json({ error: "Session missing user.id" }, { status: 401 });

    // MB Phase 4: optional ?track=career|side filter. Omitted = both tracks
    // (used by code paths that aggregate across pipelines, e.g. the calendar
    // widget pulling all upcoming interviews). Unrecognized values fall
    // through to "all" rather than 400 — matches the lenient handling on
    // /api/watchlists and /api/postings.
    const trackParam = req.nextUrl.searchParams.get("track");
    const trackFilter = trackParam ? ApplicationTrackSchema.safeParse(trackParam) : null;
    const track = trackFilter?.success ? trackFilter.data : undefined;

    try {
        const applications = await findApplicationsByUser(userId, track);
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
    const { company, role, location, url, status, kind, track, nextSteps, dateApplied, decisionDeadline } = parsed.data;
    const now = new Date();

    try {
        // lastUpdateAt = dateApplied when provided, else now. The kanban
        // displays this as the status-change date; for a manual create the
        // initial status was reached on the apply date, not on the day the
        // user happened to log into the dashboard to record it.
        const initialAppliedDate = dateApplied ? new Date(dateApplied) : null;
        const application = await createApplication({
            userId,
            company,
            role: role ?? '',
            location: location ?? null,
            url: url ?? null,
            status,
            kind: kind ?? null,
            track,
            nextSteps: nextSteps ?? null,
            dateApplied: initialAppliedDate ?? undefined,
            decisionDeadline: decisionDeadline ? new Date(decisionDeadline) : undefined,
            lastUpdateAt: initialAppliedDate ?? now,
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
    const { id, company, role, location, url, status, kind, track, nextSteps, dateApplied, decisionDeadline, canonId } = parsed.data;

    try {
        const existing = await findApplicationByIdForUser(id, userId);
        if (!existing) {
            return NextResponse.json({ error: "Application not found" }, { status: 404 });
        }

        // Canon tag (§6 Q4) — verify a non-null canon belongs to this user
        // before linking, so a tag can't point at someone else's canon.
        if (canonId) {
            const ownCanon = await prisma.canon.findFirst({ where: { id: canonId, userId }, select: { id: true } });
            if (!ownCanon) {
                return NextResponse.json({ error: "Canon not found" }, { status: 400 });
            }
        }

        // lastUpdateAt tracks the LAST STATUS CHANGE (not metadata edits like
        // notes, role, decisionDeadline) — kanban displays it as the
        // "this app's status moved on …" date. Only bump when status actually
        // differs from the stored value (2026-05-20 semantic change).
        const statusChanged = status !== undefined && status !== existing.status;
        const update: ApplicationUpdate = {};
        if (statusChanged) update.lastUpdateAt = new Date();
        if (company !== undefined) update.company = company;
        if (role !== undefined) update.role = role;
        if (location !== undefined) update.location = location;
        if (url !== undefined) update.url = url;
        if (status !== undefined) update.status = status;
        if (kind !== undefined) update.kind = kind;
        if (track !== undefined) update.track = track;
        if (nextSteps !== undefined) update.nextSteps = nextSteps;
        if (dateApplied !== undefined) update.dateApplied = dateApplied ? new Date(dateApplied) : null;
        if (decisionDeadline !== undefined) update.decisionDeadline = decisionDeadline ? new Date(decisionDeadline) : null;
        if (canonId !== undefined) update.canonId = canonId;

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
