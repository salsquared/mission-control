import { NextRequest, NextResponse } from "next/server";
import { getGoogleAuthClient } from "@/lib/googleapis";
import { google } from "googleapis";

// GET handler to check for existing events
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const userId = searchParams.get("userId");
    const query = searchParams.get("query"); // search term like company name

    if (!userId) {
      return NextResponse.json({ error: "Missing userId" }, { status: 400 });
    }

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

// POST handler to create or update an event
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { userId, eventId, summary, description, start, end } = body;

    if (!userId || !summary || !start || !end) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    const authClient = await getGoogleAuthClient(userId);
    const calendar = google.calendar({ version: "v3", auth: authClient });

    const event = {
      summary,
      description,
      start: { dateTime: start, timeZone: "UTC" }, // Adjust depending on parse result timezone
      end: { dateTime: end, timeZone: "UTC" },
    };

    if (eventId) {
      const response = await calendar.events.update({
        calendarId: "primary",
        eventId: eventId,
        requestBody: event,
      });
      return NextResponse.json({ event: response.data }, { status: 200 });
    } else {
      const response = await calendar.events.insert({
        calendarId: "primary",
        requestBody: event,
      });
      return NextResponse.json({ event: response.data }, { status: 200 });
    }
  } catch (error: any) {
    console.error("Error creating/updating calendar event:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// DELETE handler to delete an event
export async function DELETE(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const userId = searchParams.get("userId");
    const eventId = searchParams.get("eventId");

    if (!userId || !eventId) {
      return NextResponse.json({ error: "Missing userId or eventId" }, { status: 400 });
    }

    const authClient = await getGoogleAuthClient(userId);
    const calendar = google.calendar({ version: "v3", auth: authClient });

    await calendar.events.delete({
      calendarId: "primary",
      eventId: eventId,
    });

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error: any) {
    console.error("Error deleting calendar event:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
