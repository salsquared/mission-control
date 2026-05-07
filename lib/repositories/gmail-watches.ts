import { prisma } from '@/lib/prisma';
import type { GmailWatch } from '@prisma/client';

export function findGmailWatch(userId: string): Promise<GmailWatch | null> {
    return prisma.gmailWatch.findUnique({ where: { userId } });
}

export function upsertGmailWatch(data: {
    userId: string;
    historyId: string;
    expiresAt: Date;
}): Promise<GmailWatch> {
    return prisma.gmailWatch.upsert({
        where: { userId: data.userId },
        create: data,
        update: {
            historyId: data.historyId,
            expiresAt: data.expiresAt,
        },
    });
}

export function updateWatchHistoryId(userId: string, historyId: string): Promise<GmailWatch> {
    return prisma.gmailWatch.update({
        where: { userId },
        data: { historyId },
    });
}
