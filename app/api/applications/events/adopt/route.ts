import { NextRequest, NextResponse } from "next/server";
import { google } from "googleapis";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth-guards";
import { broadcastEvent } from "@/lib/events";
import { getGoogleAuthClient } from "@/lib/googleapis";
import {
    GCAL_APPLICATION_TAG,
    GCAL_EVENT_TAG,
} from "@/lib/calendar/sync";
import { ApplicationEventAdoptPostSchema } from "@/lib/schemas/applicationEvents";

export const runtime = "nodejs";

/**
 * Adopt an existing Gcal event into mission-control:
 *   1. Validate the Gcal event isn't already adopted (no MS tag yet).
 *   2. Create an ApplicationEvent row mirroring its fields, with
 *      gcalEventId pre-set so future MS edits patch it in place.
 *   3. PATCH the Gcal event to add the MS extendedProperties so the next
 *      candidates list excludes it and the reverse syncToken sweep can
 *      identify ownership.
 */
export async function POST(req: NextRequest) {
    const guard = await requireSession();
    if ('error' in guard) return guard.error;
    const userId = (guard.session.user as { id?: string }).id;
    if (!userId) return NextResponse.json({ error: "Session missing user.id" }, { status: 401 });

    const parsed = ApplicationEventAdoptPostSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
        return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
    }

    const app = await prisma.application.findUnique({
        where: { id: parsed.data.applicationId },
        select: { userId: true, company: true, role: true },
    });
    if (!app || app.userId !== userId) {
        return NextResponse.json({ error: "Application not found" }, { status: 404 });
    }

    // RAH-18: scope the duplicate check to this user. Single-user today, but
    // a global findFirst({ where: { gcalEventId } }) leaks the moment a second
    // user logs in — they'd see "already linked" errors for events owned by
    // another user's calendar (Google calendar IDs aren't globally unique
    // anyway, but the failure mode is wrong).
    const existing = await prisma.applicationEvent.findFirst({
        where: { gcalEventId: parsed.data.gcalEventId, application: { userId } },
    });
    if (existing) {
        return NextResponse.json({ error: "Gcal event is already linked to an ApplicationEvent" }, { status: 409 });
    }

    const auth = await getGoogleAuthClient(userId);
    const calendar = google.calendar({ version: "v3", auth });

    const gcalRes = await calendar.events.get({
        calendarId: "primary",
        eventId: parsed.data.gcalEventId,
    });
    const gcalItem = gcalRes.data;
    if (!gcalItem.start?.dateTime) {
        return NextResponse.json({ error: "Gcal event has no start dateTime" }, { status: 400 });
    }

    const startsAt = new Date(gcalItem.start.dateTime);
    const endsAt = gcalItem.end?.dateTime ? new Date(gcalItem.end.dateTime) : null;
    const occurredAt = new Date();

    const event = await prisma.applicationEvent.create({
        data: {
            applicationId: parsed.data.applicationId,
            kind: parsed.data.kind,
            title: parsed.data.title ?? gcalItem.summary ?? `${app.company} event`,
            occurredAt,
            scheduledAt: startsAt,
            endsAt,
            notes: gcalItem.description ?? null,
            gcalEventId: parsed.data.gcalEventId,
            gcalUpdatedAt: gcalItem.updated ? new Date(gcalItem.updated) : null,
            syncSource: "gcal",
        },
        include: { application: { select: { company: true, role: true } } },
    });

    // Tag the Gcal event so future syncs recognize it as ours.
    try {
        await calendar.events.patch({
            calendarId: "primary",
            eventId: parsed.data.gcalEventId,
            requestBody: {
                extendedProperties: {
                    private: {
                        [GCAL_EVENT_TAG]: event.id,
                        [GCAL_APPLICATION_TAG]: parsed.data.applicationId,
                    },
                },
            },
        });
    } catch (err) {
        // Tagging is best-effort — the row exists and the gcalEventId match
        // is enough for reverse sync. Untagged Gcal events still appear in
        // future candidates lists, but the duplicate guard above will reject
        // re-adopting the same one.
        console.warn(`[gcal-adopt] tag patch failed for ${parsed.data.gcalEventId}: ${(err as Error).message}`);
    }

    broadcastEvent({ model: "CalendarEvent", action: "upsert", id: event.id, timestamp: Date.now() });
    return NextResponse.json({ event }, { status: 200 });
}
