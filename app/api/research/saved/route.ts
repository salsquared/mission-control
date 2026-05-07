import { NextResponse } from 'next/server';
import { requireLocalOrSession } from '@/lib/auth-guards';
import { broadcastEvent } from '@/lib/events';
import { findSavedPapers, upsertSavedPaper, deleteSavedPaper } from '@/lib/repositories/saved-papers';

export async function GET(request: Request) {
    const guard = await requireLocalOrSession(request);
    if ('error' in guard) return guard.error;

    try {
        const { searchParams } = new URL(request.url);
        const topic = searchParams.get('topic');
        const status = searchParams.get('status');

        const savedPapers = await findSavedPapers({ topic, status });

        return NextResponse.json(savedPapers);
    } catch (error) {
        console.error("Error fetching saved papers:", error);
        return NextResponse.json({ error: "Failed to fetch saved papers" }, { status: 500 });
    }
}

export async function POST(request: Request) {
    const guard = await requireLocalOrSession(request);
    if ('error' in guard) return guard.error;

    try {
        const body = await request.json();
        const { paperId, title, summary, url, authors, publishedAt, topic, status } = body;

        if (!paperId || !status || !topic) {
            return NextResponse.json({ error: "Missing required fields: paperId, status, topic" }, { status: 400 });
        }

        const paper = await upsertSavedPaper({
            paperId,
            title: title || "Unknown Title",
            summary: summary || "",
            url: url || `https://arxiv.org/abs/${paperId}`,
            authors: authors || "Unknown",
            publishedAt: publishedAt ? new Date(publishedAt) : new Date(),
            topic,
            status,
        });

        broadcastEvent({ model: 'SavedPaper', action: 'upsert', id: paper.paperId, timestamp: Date.now() });
        return NextResponse.json(paper);
    } catch (error) {
        console.error("Error saving paper:", error);
        return NextResponse.json({ error: "Failed to save paper" }, { status: 500 });
    }
}

export async function DELETE(request: Request) {
    const guard = await requireLocalOrSession(request);
    if ('error' in guard) return guard.error;

    try {
        const { searchParams } = new URL(request.url);
        const paperId = searchParams.get('paperId');

        if (!paperId) {
            return NextResponse.json({ error: "Missing paperId" }, { status: 400 });
        }

        await deleteSavedPaper(paperId);

        broadcastEvent({ model: 'SavedPaper', action: 'delete', id: paperId, timestamp: Date.now() });
        return NextResponse.json({ success: true });
    } catch (error) {
        console.error("Error deleting saved paper:", error);
        return NextResponse.json({ error: "Failed to delete saved paper" }, { status: 500 });
    }
}
