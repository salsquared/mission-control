import { google } from "googleapis";
import type { ApplicationEvent } from "@prisma/client";
import { getGoogleAuthClient } from "@/lib/googleapis";
import { prisma } from "@/lib/prisma";

export const GCAL_EVENT_TAG = "mission-control:appEventId";
export const GCAL_APPLICATION_TAG = "mission-control:applicationId";

export interface GcalSyncContext {
    company?: string;
    role?: string | null;
}

/**
 * Mirror an ApplicationEvent to the user's primary Google Calendar.
 *
 * - First sync (no gcalEventId) → events.insert and write the returned id back.
 * - Subsequent sync → events.patch in place.
 *
 * Sync is best-effort: failures are logged through the captured `console`
 * (which feeds the in-app log viewer) and the function returns null instead
 * of throwing. The DB is the source of truth; if Gcal is briefly unreachable
 * the user just won't see this event in their calendar until the next sync.
 *
 * Skips events without `scheduledAt` (status notes / past-only milestones).
 */
export async function syncEventToGcal(
    userId: string,
    event: ApplicationEvent,
    ctx?: GcalSyncContext
): Promise<string | null> {
    if (!event.scheduledAt) return null;

    let calendar;
    try {
        const auth = await getGoogleAuthClient(userId);
        calendar = google.calendar({ version: "v3", auth });
    } catch (err) {
        console.warn(`[gcal-sync] auth failed for user ${userId}: ${(err as Error).message}`);
        return null;
    }

    const requestBody = {
        summary: event.title,
        description: buildDescription(event, ctx),
        start: { dateTime: event.scheduledAt.toISOString(), timeZone: "UTC" },
        end: {
            dateTime: (event.endsAt ?? new Date(event.scheduledAt.getTime() + 60 * 60 * 1000)).toISOString(),
            timeZone: "UTC",
        },
        extendedProperties: {
            private: {
                [GCAL_EVENT_TAG]: event.id,
                [GCAL_APPLICATION_TAG]: event.applicationId,
            },
        },
    };

    try {
        if (event.gcalEventId) {
            const res = await calendar.events.patch({
                calendarId: "primary",
                eventId: event.gcalEventId,
                requestBody,
            });
            if (res.data.updated) {
                await prisma.applicationEvent.update({
                    where: { id: event.id },
                    data: { gcalUpdatedAt: new Date(res.data.updated) },
                });
            }
            return event.gcalEventId;
        }
        const res = await calendar.events.insert({ calendarId: "primary", requestBody });
        const gcalId = res.data.id ?? null;
        if (gcalId) {
            await prisma.applicationEvent.update({
                where: { id: event.id },
                data: {
                    gcalEventId: gcalId,
                    gcalUpdatedAt: res.data.updated ? new Date(res.data.updated) : null,
                },
            });
        }
        return gcalId;
    } catch (err) {
        console.warn(`[gcal-sync] sync failed for event ${event.id}: ${(err as Error).message}`);
        return null;
    }
}

/**
 * Pull recently-changed Gcal events for the user and apply updates back to
 * matching ApplicationEvent rows. Uses Google's syncToken protocol for
 * incremental sync — the very first call (no stored token) walks the last
 * 30 days; later calls only see changes since the last successful sync.
 *
 * Conflict resolution is last-write-wins: if our row.updatedAt is newer than
 * the Gcal event's `updated` timestamp, we skip the update. This avoids
 * clobbering an MS-side edit that hasn't pushed yet.
 *
 * Only events whose `gcalEventId` already lives in our DB are touched.
 * Unsynced Gcal events stay outside MS; they only enter via the explicit
 * adopt flow.
 *
 * On 410 (syncToken expired), we clear the token and bail — the next call
 * will re-init from a fresh full sync. Returns counts so the UI can toast.
 */
export async function pullGcalChanges(
    userId: string
): Promise<{ applied: number; deleted: number; reset: boolean }> {
    let calendar;
    try {
        const auth = await getGoogleAuthClient(userId);
        calendar = google.calendar({ version: "v3", auth });
    } catch (err) {
        console.warn(`[gcal-sync] auth failed for user ${userId}: ${(err as Error).message}`);
        return { applied: 0, deleted: 0, reset: false };
    }

    const state = await prisma.gcalSyncState.findUnique({ where: { userId } });
    const counts = { applied: 0, deleted: 0, reset: false };
    let pageToken: string | undefined;
    let nextSyncToken: string | undefined;

    do {
        let res;
        try {
            res = await calendar.events.list(
                state?.syncToken
                    ? { calendarId: "primary", syncToken: state.syncToken, pageToken }
                    : {
                          calendarId: "primary",
                          timeMin: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
                          pageToken,
                          singleEvents: true,
                      }
            );
        } catch (err: unknown) {
            const code = (err as { code?: number; response?: { status?: number } })?.code
                ?? (err as { response?: { status?: number } })?.response?.status;
            if (code === 410) {
                // syncToken invalidated — Google trims old tokens. Wipe and
                // require the next call to do a fresh full sync.
                await prisma.gcalSyncState.upsert({
                    where: { userId },
                    create: { userId, syncToken: null },
                    update: { syncToken: null },
                });
                counts.reset = true;
                return counts;
            }
            console.warn(`[gcal-sync] pull failed: ${(err as Error).message}`);
            return counts;
        }

        for (const item of res.data.items ?? []) {
            if (!item.id) continue;
            const row = await prisma.applicationEvent.findFirst({ where: { gcalEventId: item.id } });
            if (!row) continue;

            if (item.status === "cancelled") {
                await prisma.applicationEvent.delete({ where: { id: row.id } });
                counts.deleted += 1;
                continue;
            }

            const gcalUpdated = item.updated ? new Date(item.updated) : null;
            // Last-write-wins. Tie goes to Gcal (rare; usually distinguishable).
            if (gcalUpdated && row.updatedAt && row.updatedAt > gcalUpdated) continue;

            await prisma.applicationEvent.update({
                where: { id: row.id },
                data: {
                    title: item.summary ?? row.title,
                    notes: item.description ?? row.notes,
                    scheduledAt: item.start?.dateTime ? new Date(item.start.dateTime) : row.scheduledAt,
                    endsAt: item.end?.dateTime ? new Date(item.end.dateTime) : row.endsAt,
                    gcalUpdatedAt: gcalUpdated,
                    syncSource: "gcal",
                },
            });
            counts.applied += 1;
        }

        pageToken = res.data.nextPageToken ?? undefined;
        if (res.data.nextSyncToken) nextSyncToken = res.data.nextSyncToken;
    } while (pageToken);

    if (nextSyncToken) {
        await prisma.gcalSyncState.upsert({
            where: { userId },
            create: { userId, syncToken: nextSyncToken },
            update: { syncToken: nextSyncToken },
        });
    }

    return counts;
}

export async function deleteEventFromGcal(userId: string, gcalEventId: string): Promise<void> {
    try {
        const auth = await getGoogleAuthClient(userId);
        const calendar = google.calendar({ version: "v3", auth });
        await calendar.events.delete({ calendarId: "primary", eventId: gcalEventId });
    } catch (err: unknown) {
        // 410 Gone = already deleted on Google's side. Treat as success.
        const status = (err as { code?: number; response?: { status?: number } })?.code
            ?? (err as { response?: { status?: number } })?.response?.status;
        if (status === 410 || status === 404) return;
        console.warn(`[gcal-sync] delete failed for gcalEvent ${gcalEventId}: ${(err as Error).message}`);
    }
}

function buildDescription(event: ApplicationEvent, ctx?: GcalSyncContext): string {
    const parts: string[] = [];
    if (ctx?.company) parts.push(`Company: ${ctx.company}`);
    if (ctx?.role) parts.push(`Role: ${ctx.role}`);
    if (event.notes) parts.push(event.notes);
    parts.push(`\n— Mission Control (eventId: ${event.id})`);
    return parts.join("\n");
}
