import { NextRequest, NextResponse } from "next/server";
import { getGoogleAuthClient } from "@/lib/googleapis";
import { google } from "googleapis";
import { requireSessionOrService, type ServiceTokenConfig } from "@/lib/auth-guards";
import { broadcastEvent } from "@/lib/events";
import { CalendarEventPostSchema } from "@/lib/schemas/calendar";
import { USER_TIMEZONE, GCAL_EVENT_TAG } from "@/lib/calendar/sync";

const PULSAR_SERVICE_CONFIG: ServiceTokenConfig = {
  tokenEnv: 'SERVICE_TOKEN_PULSAR',
  userIdEnv: 'SERVICE_TOKEN_PULSAR_USER_ID',
};

// Pin to Node runtime — googleapis pulls in undici which uses `node:*` imports
// the edge runtime can't handle. Belt-and-suspenders alongside
// serverExternalPackages in next.config.ts.
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const guard = await requireSessionOrService(req, PULSAR_SERVICE_CONFIG);
  if ('error' in guard) return guard.error;
  const { userId } = guard;

  try {
    const { searchParams } = new URL(req.url);
    const query = searchParams.get("query");

    const authClient = await getGoogleAuthClient(userId);
    const calendar = google.calendar({ version: "v3", auth: authClient });

    const response = await calendar.events.list({
      calendarId: "primary",
      q: query || undefined,
      timeMin: new Date().toISOString(),
      maxResults: 10,
      singleEvents: true,
      orderBy: "startTime",
    });

    return NextResponse.json({ events: response.data.items }, { status: 200 });
  } catch (error: any) {
    console.error("Error fetching calendar events:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const guard = await requireSessionOrService(req, PULSAR_SERVICE_CONFIG);
  if ('error' in guard) return guard.error;
  const { userId } = guard;

  try {
    const parsed = CalendarEventPostSchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
    }
    const { eventId, summary, description, start, end } = parsed.data;

    const authClient = await getGoogleAuthClient(userId);
    const calendar = google.calendar({ version: "v3", auth: authClient });

    const event = {
      summary,
      description,
      // PB-10 (was RAH-15): use the user/server IANA tz instead of "UTC". Mission-control
      // runs on a single Mac mini, so server tz === user tz.
      start: { dateTime: start, timeZone: USER_TIMEZONE },
      end: { dateTime: end, timeZone: USER_TIMEZONE },
    };

    if (eventId) {
      const response = await calendar.events.update({
        calendarId: "primary",
        eventId,
        requestBody: event,
      });
      broadcastEvent({ model: 'CalendarEvent', action: 'upsert', id: eventId, timestamp: Date.now() });
      return NextResponse.json({ event: response.data }, { status: 200 });
    } else {
      const response = await calendar.events.insert({
        calendarId: "primary",
        requestBody: event,
      });
      const newId = response.data.id ?? undefined;
      broadcastEvent({ model: 'CalendarEvent', action: 'upsert', id: newId, timestamp: Date.now() });
      return NextResponse.json({ event: response.data }, { status: 200 });
    }
  } catch (error: any) {
    console.error("Error creating/updating calendar event:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const guard = await requireSessionOrService(req, PULSAR_SERVICE_CONFIG);
  if ('error' in guard) return guard.error;
  const { userId } = guard;

  try {
    const { searchParams } = new URL(req.url);
    const eventId = searchParams.get("eventId");

    if (!eventId) {
      return NextResponse.json({ error: "Missing eventId" }, { status: 400 });
    }

    const authClient = await getGoogleAuthClient(userId);
    const calendar = google.calendar({ version: "v3", auth: authClient });

    // RAH-20: require the Gcal event carry the mission-control tag before
    // deleting. Without this check, a service-token caller (Pulsar) with the
    // right onBehalfOf userId could delete ANY event on the user's primary
    // calendar — dentist appointments, personal events, the lot. Tag-gating
    // limits the blast radius to events we created (mirroring the adopt-route
    // ownership model).
    let existing;
    try {
      existing = await calendar.events.get({ calendarId: "primary", eventId });
    } catch (err: any) {
      const status = err?.code ?? err?.response?.status;
      if (status === 404 || status === 410) {
        return NextResponse.json({ error: "Calendar event not found" }, { status: 404 });
      }
      throw err;
    }
    const msTag = existing.data.extendedProperties?.private?.[GCAL_EVENT_TAG];
    if (!msTag) {
      return NextResponse.json(
        { error: "Refusing to delete: event lacks mission-control tag" },
        { status: 403 },
      );
    }

    await calendar.events.delete({
      calendarId: "primary",
      eventId,
    });

    broadcastEvent({ model: 'CalendarEvent', action: 'delete', id: eventId, timestamp: Date.now() });
    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error: any) {
    console.error("Error deleting calendar event:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
