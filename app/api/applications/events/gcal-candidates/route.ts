import { NextRequest, NextResponse } from "next/server";
import { google } from "googleapis";
import { requireSession } from "@/lib/auth-guards";
import { getGoogleAuthClient } from "@/lib/googleapis";
import { GCAL_EVENT_TAG } from "@/lib/calendar/sync";

export const runtime = "nodejs";

/**
 * Lists Gcal events in the next 90 days that aren't already linked to a
 * mission-control ApplicationEvent (no extendedProperties.private[
 * "mission-control:appEventId"] set).
 *
 * Used by the "adopt existing event" flow — user picks a calendar entry
 * they made manually and ties it to an Application.
 */
export async function GET(req: NextRequest) {
    const guard = await requireSession();
    if ('error' in guard) return guard.error;
    const userId = (guard.session.user as { id?: string }).id;
    if (!userId) return NextResponse.json({ error: "Session missing user.id" }, { status: 401 });

    const auth = await getGoogleAuthClient(userId);
    const calendar = google.calendar({ version: "v3", auth });

    const horizonDays = Number(new URL(req.url).searchParams.get("horizonDays") ?? "90");
    const timeMin = new Date().toISOString();
    const timeMax = new Date(Date.now() + horizonDays * 24 * 60 * 60 * 1000).toISOString();

    const res = await calendar.events.list({
        calendarId: "primary",
        timeMin,
        timeMax,
        singleEvents: true,
        orderBy: "startTime",
        maxResults: 100,
    });

    const candidates = (res.data.items ?? [])
        .filter((item) => {
            if (!item.id) return false;
            if (!item.start?.dateTime) return false; // skip all-day events
            // Drop anything we've already adopted/created (has the tag).
            const tag = item.extendedProperties?.private?.[GCAL_EVENT_TAG];
            return !tag;
        })
        .map((item) => ({
            gcalEventId: item.id!,
            summary: item.summary ?? "(untitled)",
            scheduledAt: item.start!.dateTime!,
            endsAt: item.end?.dateTime ?? null,
            description: item.description ?? null,
        }));

    return NextResponse.json({ candidates }, { status: 200 });
}
