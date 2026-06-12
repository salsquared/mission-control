import { NextResponse } from 'next/server';
import { requireLocalOrSession } from '@/lib/auth-guards';
import { resolveScopedUserId } from '@/lib/user-scope';
import { broadcastEvent } from '@/lib/events';
import { findSavedPapers, upsertSavedPaper, deleteSavedPaper } from '@/lib/repositories/saved-papers';
import {
    SavedPaperPostSchema,
    SavedPaperDeleteQuerySchema,
    SavedPaperListQuerySchema,
} from '@/lib/schemas/saved-papers';

// P2.2 (OQ2a): every handler scopes to the session user (or the LAN owner
// fallback — see lib/user-scope.ts).
const NO_USER = () =>
    NextResponse.json({ error: 'No user account resolvable for this request' }, { status: 401 });

export async function GET(request: Request) {
    const guard = await requireLocalOrSession(request);
    if ('error' in guard) return guard.error;
    const userId = await resolveScopedUserId(guard);
    if (!userId) return NO_USER();

    try {
        const { searchParams } = new URL(request.url);
        const queryParsed = SavedPaperListQuerySchema.safeParse({
            topic: searchParams.get('topic'),
            status: searchParams.get('status'),
        });
        if (!queryParsed.success) {
            return NextResponse.json({ error: queryParsed.error.issues }, { status: 400 });
        }

        const savedPapers = await findSavedPapers(userId, queryParsed.data);

        return NextResponse.json(savedPapers);
    } catch (error) {
        console.error("Error fetching saved papers:", error);
        return NextResponse.json({ error: "Failed to fetch saved papers" }, { status: 500 });
    }
}

export async function POST(request: Request) {
    const guard = await requireLocalOrSession(request);
    if ('error' in guard) return guard.error;
    const userId = await resolveScopedUserId(guard);
    if (!userId) return NO_USER();

    try {
        const parsed = SavedPaperPostSchema.safeParse(await request.json());
        if (!parsed.success) {
            return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
        }
        const { paperId, title, summary, url, authors, publishedAt, topic, status } = parsed.data;

        const paper = await upsertSavedPaper(userId, {
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
    const userId = await resolveScopedUserId(guard);
    if (!userId) return NO_USER();

    try {
        const { searchParams } = new URL(request.url);
        const queryParsed = SavedPaperDeleteQuerySchema.safeParse({
            paperId: searchParams.get('paperId'),
        });
        if (!queryParsed.success) {
            return NextResponse.json({ error: queryParsed.error.issues }, { status: 400 });
        }
        const { paperId } = queryParsed.data;

        await deleteSavedPaper(userId, paperId);

        broadcastEvent({ model: 'SavedPaper', action: 'delete', id: paperId, timestamp: Date.now() });
        return NextResponse.json({ success: true });
    } catch (error) {
        console.error("Error deleting saved paper:", error);
        return NextResponse.json({ error: "Failed to delete saved paper" }, { status: 500 });
    }
}
