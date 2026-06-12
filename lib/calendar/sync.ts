import { createHash } from "crypto";
import { google } from "googleapis";
import type { ApplicationEvent } from "@prisma/client";
import { getGoogleAuthClient } from "@/lib/googleapis";
import { prisma } from "@/lib/prisma";

export const GCAL_EVENT_TAG = "mission-control:appEventId";
export const GCAL_APPLICATION_TAG = "mission-control:applicationId";

/**
 * PA-1 (PB-5 audit follow-up): derive a Google-compatible idempotency id
 * from our ApplicationEvent.id so a retry never creates a duplicate Gcal
 * event. Google requires base32hex (lowercase a-v + digits 0-9), 5-1024
 * chars. A sha1 hex digest is 40 chars of 0-9a-f — strict subset of the
 * allowed alphabet, and deterministic for a given eventId.
 *
 * Exported so smokes / debug tooling can reproduce the id mapping.
 */
export function gcalIdempotencyId(eventId: string): string {
    return createHash("sha1").update(eventId).digest("hex");
}

// PB-10 (was RAH-15): resolve once at module load. Gcal needs an IANA zone alongside each
// dateTime; "UTC" was technically correct (the dateTime is already in UTC via
// .toISOString()) but ambiguous when the UI sent a naive local-time string
// that JS Date parsed against the server's local tz. Passing the server's
// actual zone makes the round-trip unambiguous in both cases — Mac mini is
// the only host, so the server tz IS the user tz.
export const USER_TIMEZONE = (() => {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch {
        return "UTC";
    }
})();

export interface GcalSyncContext {
    company?: string;
    role?: string | null;
}

export interface GcalSyncOptions {
    /**
     * OQ8b (2026-06-12): when true, REAL failures (auth failure, Google API
     * error) rethrow instead of being swallowed into a `return null`. Ingest
     * sets this so its `gcalSyncedAt` checkpoint is only stamped when the
     * sync actually succeeded — otherwise the documented at-least-once retry
     * contract is broken (checkpoint stamped over a failed sync). BENIGN
     * no-ops still return null without throwing: an event with no
     * `scheduledAt` simply has nothing to mirror, and the internal 409
     * recovery is a success path. Default false keeps today's best-effort
     * contract byte-for-byte for every other caller.
     */
    throwOnError?: boolean;
}

/**
 * Mirror an ApplicationEvent to the user's primary Google Calendar.
 *
 * - First sync (no gcalEventId) → events.insert and write the returned id back.
 * - Subsequent sync → events.patch in place.
 *
 * Sync is best-effort by default: failures are logged through the captured
 * `console` (which feeds the in-app log viewer) and the function returns null
 * instead of throwing. The DB is the source of truth; if Gcal is briefly
 * unreachable the user just won't see this event in their calendar until the
 * next sync. Pass `opts.throwOnError` to surface real failures instead (see
 * GcalSyncOptions).
 *
 * Skips events without `scheduledAt` (status notes / past-only milestones).
 */
export async function syncEventToGcal(
    userId: string,
    event: ApplicationEvent,
    ctx?: GcalSyncContext,
    opts?: GcalSyncOptions
): Promise<string | null> {
    if (!event.scheduledAt) return null;

    let calendar;
    try {
        const auth = await getGoogleAuthClient(userId);
        calendar = google.calendar({ version: "v3", auth });
    } catch (err) {
        if (opts?.throwOnError) throw err;
        console.warn(`[gcal-sync] auth failed for user ${userId}: ${(err as Error).message}`);
        return null;
    }

    const requestBody = {
        summary: event.title,
        description: buildDescription(event, ctx),
        start: { dateTime: event.scheduledAt.toISOString(), timeZone: USER_TIMEZONE },
        end: {
            dateTime: (event.endsAt ?? new Date(event.scheduledAt.getTime() + 60 * 60 * 1000)).toISOString(),
            timeZone: USER_TIMEZONE,
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
        // PA-1: pass a deterministic id derived from our ApplicationEvent.id.
        // If a retry hits this code path (network dropped between Google's
        // insert succeeding and our DB write committing), Google returns 409
        // and we fetch the already-created event instead of inserting a dup.
        const idempotencyId = gcalIdempotencyId(event.id);
        let gcalId: string | null = null;
        let updatedRaw: string | null | undefined = null;
        try {
            const res = await calendar.events.insert({
                calendarId: "primary",
                requestBody: { ...requestBody, id: idempotencyId },
            });
            gcalId = res.data.id ?? null;
            updatedRaw = res.data.updated;
        } catch (insertErr: unknown) {
            const status = (insertErr as { code?: number; response?: { status?: number } })?.code
                ?? (insertErr as { response?: { status?: number } })?.response?.status;
            if (status === 409) {
                // Already-inserted on a prior run that crashed before our DB
                // write. Fetch and reconcile — the user-facing event exists.
                const existing = await calendar.events.get({
                    calendarId: "primary",
                    eventId: idempotencyId,
                });
                gcalId = existing.data.id ?? idempotencyId;
                updatedRaw = existing.data.updated;
                console.info(`[gcal-sync] recovered from 409 for event ${event.id} (idempotencyId=${idempotencyId})`);
            } else {
                throw insertErr;
            }
        }
        if (gcalId) {
            await prisma.applicationEvent.update({
                where: { id: event.id },
                data: {
                    gcalEventId: gcalId,
                    gcalUpdatedAt: updatedRaw ? new Date(updatedRaw) : null,
                },
            });
        }
        return gcalId;
    } catch (err) {
        if (opts?.throwOnError) throw err;
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

/**
 * Fix C (store undo handles — docs/archive/postmortem-self-notification-mail-loop.html §11).
 *
 * Delete a batch of ApplicationEvents *cleanly*: sweep each event's mirrored
 * Google Calendar entry by its stored `gcalEventId` FIRST, then delete the rows.
 * The §8 incident cleanup deleted rows directly, which threw away the
 * `gcalEventId`s and left ~28 orphaned calendar events that had to be cleared by
 * hand. Any bulk ApplicationEvent deletion (admin cleanup, future "undo a loop
 * window" tooling, the per-event DELETE route) MUST go through this helper so a
 * row is never removed before its external artifact.
 *
 * Tolerant by design: events with a null `gcalEventId` skip the gcal call;
 * deleteEventFromGcal already treats 404/410 as success. Best-effort on the gcal
 * leg — a calendar API hiccup is logged but never blocks the row deletion.
 * Returns counts for callers/tests to assert against.
 */
export async function purgeApplicationEvents(
    eventIds: string[]
): Promise<{ deletedRows: number; gcalSwept: number }> {
    if (eventIds.length === 0) return { deletedRows: 0, gcalSwept: 0 };

    const events = await prisma.applicationEvent.findMany({
        where: { id: { in: eventIds } },
        select: { id: true, gcalEventId: true, application: { select: { userId: true } } },
    });

    let gcalSwept = 0;
    for (const ev of events) {
        if (ev.gcalEventId) {
            await deleteEventFromGcal(ev.application.userId, ev.gcalEventId);
            gcalSwept++;
        }
    }

    const res = await prisma.applicationEvent.deleteMany({ where: { id: { in: eventIds } } });
    return { deletedRows: res.count, gcalSwept };
}

function buildDescription(event: ApplicationEvent, ctx?: GcalSyncContext): string {
    const parts: string[] = [];
    if (ctx?.company) parts.push(`Company: ${ctx.company}`);
    if (ctx?.role) parts.push(`Role: ${ctx.role}`);
    if (event.notes) parts.push(event.notes);
    parts.push(`\n— Mission Control (eventId: ${event.id})`);
    return parts.join("\n");
}
