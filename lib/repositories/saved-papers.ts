import { prisma } from '@/lib/prisma';
import type { SavedPaper } from '@prisma/client';

// P2.2 (OQ2a): userId-scoped — the legacy global `paperId @unique` became the
// compound @@unique([userId, paperId]) so two users can save the same paper
// and an upsert can never touch another user's row.

export interface SavedPaperUpsert {
    paperId: string;
    title: string;
    summary: string;
    url: string;
    authors: string;
    publishedAt: Date;
    topic: string;
    status: string;
}

export interface SavedPaperFilter {
    topic?: string | null;
    status?: string | null;
}

export function findSavedPapers(userId: string, filter: SavedPaperFilter = {}): Promise<SavedPaper[]> {
    const where: { userId: string; topic?: string; status?: string } = { userId };
    if (filter.topic) where.topic = filter.topic;
    if (filter.status) where.status = filter.status;
    return prisma.savedPaper.findMany({
        where,
        orderBy: { createdAt: 'desc' },
    });
}

export function upsertSavedPaper(userId: string, data: SavedPaperUpsert): Promise<SavedPaper> {
    return prisma.savedPaper.upsert({
        where: { userId_paperId: { userId, paperId: data.paperId } },
        update: {
            status: data.status,
            topic: data.topic,
        },
        create: { ...data, userId },
    });
}

export function deleteSavedPaper(userId: string, paperId: string): Promise<SavedPaper> {
    return prisma.savedPaper.delete({ where: { userId_paperId: { userId, paperId } } });
}
