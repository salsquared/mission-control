import { prisma } from '@/lib/prisma';
import type { ApplicationEvent, Prisma } from '@prisma/client';

export type ApplicationEventKind =
    | 'APPLIED'
    | 'STATUS_CHANGED'
    | 'EMAIL_RECEIVED'
    | 'ASSESSMENT_REQUESTED'
    | 'INTERVIEW_SCHEDULED'
    | 'OFFER'
    | 'REJECTION'
    | 'NOTE';

export interface ApplicationEventDraft {
    applicationId: string;
    kind: ApplicationEventKind;
    title: string;
    occurredAt: Date;
    scheduledAt?: Date | null;
    endsAt?: Date | null;
    fromStatus?: string | null;
    toStatus?: string | null;
    notes?: string | null;
    emailMsgId?: string | null;
    syncSource?: 'ms' | 'gcal' | null;
}

/**
 * Insert a batch of events, skipping any that collide with the
 * (applicationId, emailMsgId, kind) unique constraint. Returns the rows
 * that were actually inserted (callers chain Gcal sync off these).
 *
 * Uses individual creates because Prisma's TS types disallow `skipDuplicates`
 * on SQLite even though the runtime supports `ON CONFLICT IGNORE`. With
 * typical ingest emitting ~3-5 rows per email, the loop cost is trivial.
 */
// ApplicationEvent kinds that warrant an in-app Notification when they fire.
// (Story S6.3.) Things the user MUST see: interviews getting scheduled, offers,
// rejections, assessments coming in. Skip the noisy/self-initiated kinds
// (APPLIED, STATUS_CHANGED, EMAIL_RECEIVED, NOTE).
// Exported (PB-5) so ingest.ts can check whether an event needed notifying
// before deciding if a re-run can early-exit.
export const NOTIFY_EVENT_KINDS = new Set([
    "INTERVIEW_SCHEDULED",
    "OFFER",
    "REJECTION",
    "ASSESSMENT_REQUESTED",
]);

/**
 * Fire a Notification for an event of attention-worthy kind. Best-effort —
 * a notification failure must not fail the caller's create.
 */
export async function maybeNotifyForApplicationEvent(
    event: { id: string; kind: string; title: string; applicationId: string; scheduledAt: Date | null; notes: string | null },
    userId: string,
    companyHint?: string,
): Promise<void> {
    if (!NOTIFY_EVENT_KINDS.has(event.kind)) return;
    const body = event.scheduledAt
        ? `${event.scheduledAt.toLocaleString()}${event.notes ? ` · ${event.notes.slice(0, 120)}` : ""}`
        : event.notes ?? null;
    const title = companyHint
        ? `${companyHint} — ${event.title}`
        : event.title;
    // Critical-tier per lib/notifications/dispatch.ts: in-app + email.
    // These are the high-signal events (interview scheduled, offer, rejection,
    // assessment requested) that warrant pushing past the dashboard into the
    // user's inbox.
    try {
        const { dispatchNotification } = await import("@/lib/notifications/dispatch");
        await dispatchNotification({
            userId,
            tier: "critical",
            kind: "application",
            title,
            body,
            payload: {
                applicationId: event.applicationId,
                eventId: event.id,
                eventKind: event.kind,
            },
            // PB-8: one notification per event, ever. Combined with the PB-5
            // notifiedAt checkpoint this gives true at-most-once semantics —
            // even if ingest re-runs after a crash AND PB-5's checkpoint had
            // not been stamped, the @unique catches it.
            dedupKey: `event:${event.id}`,
        });
    } catch (e) {
        console.warn(`[applicationEvents] dispatchNotification failed for event ${event.id}:`, e);
    }
}

export async function createApplicationEvents(
    drafts: ApplicationEventDraft[]
): Promise<ApplicationEvent[]> {
    if (drafts.length === 0) return [];
    const inserted: ApplicationEvent[] = [];
    for (const d of drafts) {
        try {
            const row = await prisma.applicationEvent.create({
                data: {
                    applicationId: d.applicationId,
                    kind: d.kind,
                    title: d.title,
                    occurredAt: d.occurredAt,
                    scheduledAt: d.scheduledAt ?? null,
                    endsAt: d.endsAt ?? null,
                    fromStatus: d.fromStatus ?? null,
                    toStatus: d.toStatus ?? null,
                    notes: d.notes ?? null,
                    emailMsgId: d.emailMsgId ?? null,
                    syncSource: d.syncSource ?? null,
                },
            });
            inserted.push(row);
        } catch (err: any) {
            // P2002 = unique constraint violation; expected on re-ingest.
            if (err?.code === 'P2002') continue;
            throw err;
        }
    }
    return inserted;
}

export function findUpcomingEvents(
    userId: string,
    opts: { kinds?: ApplicationEventKind[]; horizonDays?: number } = {}
): Promise<(ApplicationEvent & { application: { company: string; role: string | null } })[]> {
    const { kinds, horizonDays = 90 } = opts;
    const horizonEnd = new Date(Date.now() + horizonDays * 24 * 60 * 60 * 1000);
    const where: Prisma.ApplicationEventWhereInput = {
        application: { userId },
        scheduledAt: { gte: new Date(), lte: horizonEnd },
    };
    if (kinds && kinds.length > 0) where.kind = { in: kinds };
    return prisma.applicationEvent.findMany({
        where,
        orderBy: { scheduledAt: 'asc' },
        include: { application: { select: { company: true, role: true } } },
    });
}

export function findEventsForApplication(applicationId: string): Promise<ApplicationEvent[]> {
    return prisma.applicationEvent.findMany({
        where: { applicationId },
        orderBy: { occurredAt: 'desc' },
    });
}

/**
 * Most recent event that establishes "what the Application's status was as of
 * this moment" — STATUS_CHANGED (a transition) or APPLIED (the initial
 * status anchor). Used by ingest to decide whether to apply an incoming
 * email's classification: if the email's sentAt is OLDER than this event,
 * the email's status is stale (e.g. user manually moved to ACCEPTED after
 * the offer email arrived; re-ingesting that older offer email must not
 * downgrade them back to OFFER).
 *
 * Returns null when no status anchor exists — caller should treat that as
 * "apply unconditionally" (first email creates the baseline).
 */
export function findLatestStatusAnchor(applicationId: string): Promise<ApplicationEvent | null> {
    return prisma.applicationEvent.findFirst({
        where: {
            applicationId,
            kind: { in: ['STATUS_CHANGED', 'APPLIED'] },
        },
        orderBy: { occurredAt: 'desc' },
    });
}

export function findEventByGcalId(gcalEventId: string): Promise<ApplicationEvent | null> {
    return prisma.applicationEvent.findFirst({ where: { gcalEventId } });
}
