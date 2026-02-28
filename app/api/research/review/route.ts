/* eslint-disable */
import { NextResponse } from 'next/server';
import { prisma } from '../../../../lib/prisma';
import { withCache } from '../../../../lib/cache';

function getStartOfWeek(date: Date) {
    const d = new Date(date);
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1); // adjust when day is sunday
    d.setDate(diff);
    d.setHours(0, 0, 0, 0);
    return d;
}

async function getHandler(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const topic = searchParams.get('topic') || 'ai';
        const limit = parseInt(searchParams.get('limit') || '1', 10); // Just making sure it takes size param but defaults to 1

        const now = new Date();
        const weekStart = getStartOfWeek(now);

        // Check if we already picked one for this week
        const existingSelection = await prisma.selectedReviewPaper.findFirst({
            where: {
                topic: topic.toLowerCase(),
                weekStart: weekStart,
            }
        });

        if (existingSelection) {
            const res = await fetch(`http://export.arxiv.org/api/query?id_list=${existingSelection.arxivId}`);

            if (res.ok) {
                const xml = await res.text();
                // Extract proper entry
                const entries = xml.split('<entry>');
                if (entries.length > 1) {
                    const entry = entries[1]; // First entry after header

                    const titleMatch = entry.match(/<title>([\s\S]*?)<\/title>/);
                    const summaryMatch = entry.match(/<summary>([\s\S]*?)<\/summary>/);
                    const authorMatch = entry.match(/<author>\s*<name>([\s\S]*?)<\/name>/);
                    const publishedMatch = entry.match(/<published>([\s\S]*?)<\/published>/);

                    if (titleMatch && summaryMatch) {
                        const mappedPaper = {
                            id: `http://arxiv.org/abs/${existingSelection.arxivId}`,
                            title: titleMatch[1].trim().replace(/\n/g, ' '),
                            summary: summaryMatch[1].trim(),
                            url: `https://arxiv.org/abs/${existingSelection.arxivId}`,
                            author: authorMatch ? authorMatch[1].trim() : 'Unknown',
                            published_at: publishedMatch ? publishedMatch[1].trim() : new Date().toISOString(),
                            source: 'Weekly Recommended Review',
                            arxivId: existingSelection.arxivId
                        };

                        // fetch Semantic scholar details
                        const ssRes = await fetch('https://api.semanticscholar.org/graph/v1/paper/batch?fields=title,authors,abstract,citationCount,year,url', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ ids: [`ArXiv:${existingSelection.arxivId}`] })
                        });

                        if (ssRes.ok) {
                            const ssData = await ssRes.json();
                            if (ssData[0]) {
                                (mappedPaper as any).citationCount = ssData[0].citationCount || 0;
                            }
                        }
                        return NextResponse.json([mappedPaper]);
                    }
                }
            }
        }

        // We need a new review paper roughly from the last year
        const pad = (n: number) => n.toString().padStart(2, '0');
        const searchDays = 365;
        const lastYear = new Date(now);
        lastYear.setDate(now.getDate() - searchDays);
        const dateFromStr = `${lastYear.getFullYear()}${pad(lastYear.getMonth() + 1)}${pad(lastYear.getDate())}0000`;
        const dateToStr = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}2359`;

        let arxivQuery = `cat:cs.AI`;
        if (topic.toLowerCase() === 'crypto') arxivQuery = `all:crypto`;
        if (topic.toLowerCase() === 'space') arxivQuery = `all:space`;

        const fullQuery = `${arxivQuery} AND (ti:review OR ti:survey) AND submittedDate:[${dateFromStr} TO ${dateToStr}]`;
        const fetchUrl = `http://export.arxiv.org/api/query?search_query=${encodeURIComponent(fullQuery)}&start=0&max_results=50&sortBy=relevance&sortOrder=descending`;

        const res = await fetch(fetchUrl);
        if (res.ok) {
            const xml = await res.text();

            // Extract all entries
            const entries = xml.split('<entry>');
            entries.shift(); // Remove the feed header part

            const dbPicked = await prisma.selectedReviewPaper.findMany({
                where: { topic: topic.toLowerCase() },
                select: { arxivId: true }
            });
            const pickedIds = new Set(dbPicked.map((p: any) => p.arxivId));

            // Extract IDs from all entries
            const entryRecords: { entry: string, id: string, citations: number }[] = [];
            for (const entry of entries) {
                const idMatch = entry.match(/<id>http:\/\/arxiv\.org\/abs\/(.+?)<\/id>/) || entry.match(/<id>http:\/\/arxiv\.org\/abs\/(.+?)v\d+<\/id>/);
                if (idMatch) {
                    const arxivId = idMatch[1].split('v')[0]; // Strip version if any
                    if (!pickedIds.has(arxivId)) {
                        entryRecords.push({ entry, id: arxivId, citations: 0 });
                    }
                }
            }

            if (entryRecords.length > 0) {
                // Batch fetch citations for these candidates
                // Semantic Scholar limits batch to 500, but we only have <= 50
                const batchIds = entryRecords.map(r => `ArXiv:${r.id}`);
                try {
                    const ssRes = await fetch('https://api.semanticscholar.org/graph/v1/paper/batch?fields=citationCount', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ ids: batchIds })
                    });

                    if (ssRes.ok) {
                        const ssData = await ssRes.json();
                        entryRecords.forEach((record, index) => {
                            if (ssData[index]) {
                                record.citations = ssData[index].citationCount || 0;
                            }
                        });
                    }
                } catch (err) {
                    console.error("Error fetching citations for review sorting", err);
                }

                // Sort by citations descending
                entryRecords.sort((a, b) => b.citations - a.citations);

                const topRecord = entryRecords[0];
                const selectedEntry = topRecord.entry;
                const selectedId = topRecord.id;

                // Save it to DB
                await prisma.selectedReviewPaper.create({
                    data: {
                        arxivId: selectedId,
                        topic: topic.toLowerCase(),
                        weekStart: weekStart
                    }
                });

                // Parse it
                const titleMatch = selectedEntry.match(/<title>([\s\S]*?)<\/title>/);
                const summaryMatch = selectedEntry.match(/<summary>([\s\S]*?)<\/summary>/);
                const authorMatch = selectedEntry.match(/<author>\s*<name>([\s\S]*?)<\/name>/);
                const publishedMatch = selectedEntry.match(/<published>([\s\S]*?)<\/published>/);

                const mappedPaper = {
                    id: `http://arxiv.org/abs/${selectedId}`,
                    title: titleMatch ? titleMatch[1].trim().replace(/\n/g, ' ') : 'Unknown Title',
                    summary: summaryMatch ? summaryMatch[1].trim() : 'No summary',
                    url: `https://arxiv.org/abs/${selectedId}`,
                    author: authorMatch ? authorMatch[1].trim() : 'Unknown',
                    published_at: publishedMatch ? publishedMatch[1].trim() : new Date().toISOString(),
                    source: 'Weekly Recommended Review',
                    arxivId: selectedId,
                    upvotes: 0,
                    citationCount: topRecord.citations
                };

                return NextResponse.json([mappedPaper]);
            }
        }

        return NextResponse.json([]);
    } catch (error: any) {
        console.error(`Error in review research API:`, error);
        return NextResponse.json({ error: 'Failed to fetch review paper', details: error.toString(), stack: error.stack }, { status: 500 });
    }
}

// Cache responses for an hour
export const GET = withCache(getHandler, 3600);
