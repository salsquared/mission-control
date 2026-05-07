import { prisma } from '@/lib/prisma';
import type { SelectedHistoricalPaper, SelectedReviewPaper } from '@prisma/client';

// Both SelectedHistoricalPaper and SelectedReviewPaper are weekly de-dup ledgers
// with identical schemas. They live in separate tables so each topic-of-the-week
// flow has its own state, and we mirror that here with two parallel function sets.

export function findCurrentHistoricalPick(
    topic: string,
    weekStart: Date
): Promise<SelectedHistoricalPaper | null> {
    return prisma.selectedHistoricalPaper.findFirst({
        where: { topic, weekStart },
    });
}

export async function listPickedHistoricalIds(topic: string): Promise<string[]> {
    const rows = await prisma.selectedHistoricalPaper.findMany({
        where: { topic },
        select: { paperId: true },
    });
    return rows.map(r => r.paperId);
}

export function recordHistoricalPick(
    paperId: string,
    topic: string,
    weekStart: Date
): Promise<SelectedHistoricalPaper> {
    return prisma.selectedHistoricalPaper.create({
        data: { paperId, topic, weekStart },
    });
}

export function findCurrentReviewPick(
    topic: string,
    weekStart: Date
): Promise<SelectedReviewPaper | null> {
    return prisma.selectedReviewPaper.findFirst({
        where: { topic, weekStart },
    });
}

export async function listPickedReviewIds(topic: string): Promise<string[]> {
    const rows = await prisma.selectedReviewPaper.findMany({
        where: { topic },
        select: { paperId: true },
    });
    return rows.map(r => r.paperId);
}

export function recordReviewPick(
    paperId: string,
    topic: string,
    weekStart: Date
): Promise<SelectedReviewPaper> {
    return prisma.selectedReviewPaper.create({
        data: { paperId, topic, weekStart },
    });
}
