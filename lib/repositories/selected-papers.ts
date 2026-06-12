import { prisma } from '@/lib/prisma';
import type { SelectedHistoricalPaper, SelectedReviewPaper } from '@prisma/client';

// Both SelectedHistoricalPaper and SelectedReviewPaper are weekly de-dup ledgers
// with identical schemas. They live in separate tables so each topic-of-the-week
// flow has its own state, and we mirror that here with two parallel function sets.

// Cached paper metadata persisted at pick time (docs/archive/arxiv-rate-limit-fix.html
// Layer 2). With this present, re-rendering the weekly pick costs ZERO arXiv /
// Semantic-Scholar calls. All fields nullable so legacy rows (picked before the
// backfill columns existed) read as null and trigger one lazy id_list fetch that
// then backfills the row.
export interface PickMetadata {
    title?: string | null;
    summary?: string | null;
    url?: string | null;
    author?: string | null;
    publishedAt?: Date | null;
    citationCount?: number | null;
}

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
    weekStart: Date,
    metadata?: PickMetadata
): Promise<SelectedHistoricalPaper> {
    return prisma.selectedHistoricalPaper.create({
        data: { paperId, topic, weekStart, ...metadata },
    });
}

// Backfill cached metadata onto an already-recorded pick (a legacy NULL row that
// pre-dates the metadata columns). Keyed on @@unique([paperId, topic]).
export async function backfillHistoricalPick(
    paperId: string,
    topic: string,
    metadata: PickMetadata
): Promise<void> {
    await prisma.selectedHistoricalPaper.updateMany({
        where: { paperId, topic },
        data: metadata,
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
    weekStart: Date,
    metadata?: PickMetadata
): Promise<SelectedReviewPaper> {
    return prisma.selectedReviewPaper.create({
        data: { paperId, topic, weekStart, ...metadata },
    });
}

export async function backfillReviewPick(
    paperId: string,
    topic: string,
    metadata: PickMetadata
): Promise<void> {
    await prisma.selectedReviewPaper.updateMany({
        where: { paperId, topic },
        data: metadata,
    });
}
