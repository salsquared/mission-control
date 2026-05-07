import { NextRequest, NextResponse } from "next/server";
import { getGoogleAuthClient } from "@/lib/googleapis";
import { google } from "googleapis";
import { requireSessionOrService, type ServiceTokenConfig } from "@/lib/auth-guards";
import { broadcastEvent } from "@/lib/events";
import { CalendarEventPostSchema } from "@/lib/schemas/calendar";

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
      start: { dateTime: start, timeZone: "UTC" },
      end: { dateTime: end, timeZone: "UTC" },
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
