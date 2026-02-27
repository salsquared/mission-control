import { NextResponse } from 'next/server';
import { prisma } from '../../../../lib/prisma';

export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const topic = searchParams.get('topic');
        const status = searchParams.get('status');

        const where: any = {};
        if (topic) where.topic = topic;
        if (status) where.status = status;

        // @ts-ignore - Prisma types might not have refreshed in the IDE
        const savedPapers = await (prisma as any).savedPaper.findMany({
            where,
            orderBy: {
                createdAt: 'desc'
            }
        });

        return NextResponse.json(savedPapers);
    } catch (error) {
        console.error("Error fetching saved papers:", error);
        return NextResponse.json({ error: "Failed to fetch saved papers" }, { status: 500 });
    }
}

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const { arxivId, title, summary, url, authors, publishedAt, topic, status } = body;

        if (!arxivId || !status || !topic) {
            return NextResponse.json({ error: "Missing required fields: arxivId, status, topic" }, { status: 400 });
        }

        // @ts-ignore
        const paper = await (prisma as any).savedPaper.upsert({
            where: { arxivId },
            update: {
                status,
                topic
            },
            create: {
                arxivId,
                title: title || "Unknown Title",
                summary: summary || "",
                url: url || `https://arxiv.org/abs/${arxivId}`,
                authors: authors || "Unknown",
                publishedAt: publishedAt ? new Date(publishedAt) : new Date(),
                topic,
                status
            }
        });

        return NextResponse.json(paper);
    } catch (error) {
        console.error("Error saving paper:", error);
        return NextResponse.json({ error: "Failed to save paper" }, { status: 500 });
    }
}

export async function DELETE(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const arxivId = searchParams.get('arxivId');

        if (!arxivId) {
            return NextResponse.json({ error: "Missing arxivId" }, { status: 400 });
        }

        await (prisma as any).savedPaper.delete({
            where: { arxivId }
        });

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error("Error deleting saved paper:", error);
        return NextResponse.json({ error: "Failed to delete saved paper" }, { status: 500 });
    }
}
