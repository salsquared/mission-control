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

export function findEventByGcalId(gcalEventId: string): Promise<ApplicationEvent | null> {
    return prisma.applicationEvent.findFirst({ where: { gcalEventId } });
}
