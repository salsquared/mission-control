import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth-guards";
import { broadcastEvent } from "@/lib/events";
import {
    ApplicationEventPostSchema,
    ApplicationEventPatchSchema,
    APPLICATION_EVENT_KINDS,
} from "@/lib/schemas/applicationEvents";
import { syncEventToGcal, deleteEventFromGcal } from "@/lib/calendar/sync";
import { maybeNotifyForApplicationEvent } from "@/lib/repositories/applicationEvents";

export const runtime = "nodejs";

const ALL_KINDS = new Set<string>(APPLICATION_EVENT_KINDS);

/**
 * Read application events for the signed-in user. Filters:
 *   - applicationId  -> events for one application
 *   - upcoming=true  -> only rows with scheduledAt > now (and ordered ascending)
 *   - kinds=A,B,C    -> restrict to a subset of kinds
 *
 * Without filters, returns the user's full timeline ordered by occurredAt desc.
 */
export async function GET(req: NextRequest) {
    const guard = await requireSession();
    if ('error' in guard) return guard.error;
    const userId = (guard.session.user as { id?: string }).id;
    if (!userId) return NextResponse.json({ error: "Session missing user.id" }, { status: 401 });

    const { searchParams } = new URL(req.url);
    const applicationId = searchParams.get("applicationId");
    const upcoming = searchParams.get("upcoming") === "true";
    const kindsParam = searchParams.get("kinds");
    const kinds = kindsParam
        ? kindsParam.split(",").map((s) => s.trim()).filter((k) => ALL_KINDS.has(k))
        : null;

    const where: Prisma.ApplicationEventWhereInput = {
        application: { userId },
    };
    if (applicationId) where.applicationId = applicationId;
    if (upcoming) where.scheduledAt = { gte: new Date() };
    if (kinds && kinds.length > 0) where.kind = { in: kinds };

    const events = await prisma.applicationEvent.findMany({
        where,
        orderBy: upcoming ? { scheduledAt: "asc" } : { occurredAt: "desc" },
        include: { application: { select: { company: true, role: true } } },
    });

    return NextResponse.json({ events }, { status: 200 });
}

export async function POST(req: NextRequest) {
    const guard = await requireSession();
    if ('error' in guard) return guard.error;
    const userId = (guard.session.user as { id?: string }).id;
    if (!userId) return NextResponse.json({ error: "Session missing user.id" }, { status: 401 });

    const parsed = ApplicationEventPostSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
        return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
    }

    // Confirm the application belongs to this user before writing.
    const app = await prisma.application.findUnique({
        where: { id: parsed.data.applicationId },
        select: { userId: true },
    });
    if (!app || app.userId !== userId) {
        return NextResponse.json({ error: "Application not found" }, { status: 404 });
    }

    const event = await prisma.applicationEvent.create({
        data: {
            applicationId: parsed.data.applicationId,
            kind: parsed.data.kind,
            title: parsed.data.title,
            occurredAt: parsed.data.occurredAt ? new Date(parsed.data.occurredAt) : new Date(),
            scheduledAt: parsed.data.scheduledAt ? new Date(parsed.data.scheduledAt) : null,
            endsAt: parsed.data.endsAt ? new Date(parsed.data.endsAt) : null,
            notes: parsed.data.notes ?? null,
            syncSource: "ms",
        },
        include: { application: { select: { company: true, role: true } } },
    });

    await syncEventToGcal(userId, event, {
        company: event.application.company,
        role: event.application.role,
    });

    // MB-3.1 (story 27): fire an in-app Notification for attention-worthy
    // kinds (INTERVIEW_SCHEDULED / OFFER / REJECTION / ASSESSMENT_REQUESTED).
    await maybeNotifyForApplicationEvent(event, userId, event.application.company);

    broadcastEvent({ model: "CalendarEvent", action: "upsert", id: event.id, timestamp: Date.now() });
    broadcastEvent({ model: "Notification", action: "upsert", id: userId, timestamp: Date.now() });
    return NextResponse.json({ event }, { status: 200 });
}

export async function PATCH(req: NextRequest) {
    const guard = await requireSession();
    if ('error' in guard) return guard.error;
    const userId = (guard.session.user as { id?: string }).id;
    if (!userId) return NextResponse.json({ error: "Session missing user.id" }, { status: 401 });

    const parsed = ApplicationEventPatchSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
        return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
    }

    const existing = await prisma.applicationEvent.findUnique({
        where: { id: parsed.data.id },
        include: { application: { select: { userId: true } } },
    });
    if (!existing || existing.application.userId !== userId) {
        return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const data: Record<string, unknown> = { syncSource: "ms" };
    if (parsed.data.title !== undefined) data.title = parsed.data.title;
    if (parsed.data.kind !== undefined) data.kind = parsed.data.kind;
    if (parsed.data.scheduledAt !== undefined) data.scheduledAt = parsed.data.scheduledAt ? new Date(parsed.data.scheduledAt) : null;
    if (parsed.data.endsAt !== undefined) data.endsAt = parsed.data.endsAt ? new Date(parsed.data.endsAt) : null;
    if (parsed.data.notes !== undefined) data.notes = parsed.data.notes;

    const event = await prisma.applicationEvent.update({
        where: { id: parsed.data.id },
        data,
        include: { application: { select: { company: true, role: true } } },
    });

    await syncEventToGcal(userId, event, {
        company: event.application.company,
        role: event.application.role,
    });

    broadcastEvent({ model: "CalendarEvent", action: "upsert", id: event.id, timestamp: Date.now() });
    return NextResponse.json({ event }, { status: 200 });
}

export async function DELETE(req: NextRequest) {
    const guard = await requireSession();
    if ('error' in guard) return guard.error;
    const userId = (guard.session.user as { id?: string }).id;
    if (!userId) return NextResponse.json({ error: "Session missing user.id" }, { status: 401 });

    const { searchParams } = new URL(req.url);
    const id = searchParams.get("id");
    if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

    const existing = await prisma.applicationEvent.findUnique({
        where: { id },
        include: { application: { select: { userId: true } } },
    });
    if (!existing || existing.application.userId !== userId) {
        return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    if (existing.gcalEventId) {
        await deleteEventFromGcal(userId, existing.gcalEventId);
    }
    await prisma.applicationEvent.delete({ where: { id } });
    broadcastEvent({ model: "CalendarEvent", action: "delete", id, timestamp: Date.now() });
    return NextResponse.json({ success: true }, { status: 200 });
}
