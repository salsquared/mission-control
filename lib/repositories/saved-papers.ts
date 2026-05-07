import { prisma } from '@/lib/prisma';
import type { SavedPaper } from '@prisma/client';

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

export function findSavedPapers(filter: SavedPaperFilter = {}): Promise<SavedPaper[]> {
    const where: { topic?: string; status?: string } = {};
    if (filter.topic) where.topic = filter.topic;
    if (filter.status) where.status = filter.status;
    return prisma.savedPaper.findMany({
        where,
        orderBy: { createdAt: 'desc' },
    });
}

export function upsertSavedPaper(data: SavedPaperUpsert): Promise<SavedPaper> {
    return prisma.savedPaper.upsert({
        where: { paperId: data.paperId },
        update: {
            status: data.status,
            topic: data.topic,
        },
        create: data,
    });
}

export function deleteSavedPaper(paperId: string): Promise<SavedPaper> {
    return prisma.savedPaper.delete({ where: { paperId } });
}
