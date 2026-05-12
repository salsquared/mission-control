import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guards";
import { broadcastEvent } from "@/lib/events";
import { pullGcalChanges } from "@/lib/calendar/sync";

export const runtime = "nodejs";

/**
 * Manually pull Gcal changes for the signed-in user. Idempotent — Google's
 * syncToken keeps each call tight (only what changed since last sync).
 */
export async function POST() {
    const guard = await requireSession();
    if ('error' in guard) return guard.error;
    const userId = (guard.session.user as { id?: string }).id;
    if (!userId) return NextResponse.json({ error: "Session missing user.id" }, { status: 401 });

    const result = await pullGcalChanges(userId);
    if (result.applied > 0 || result.deleted > 0) {
        broadcastEvent({ model: "CalendarEvent", action: "invalidate", timestamp: Date.now() });
    }
    return NextResponse.json(result, { status: 200 });
}
