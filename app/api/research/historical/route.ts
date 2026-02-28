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
        const limit = parseInt(searchParams.get('limit') || '1', 10);

        const now = new Date();
        const weekStart = getStartOfWeek(now);

        // Check if we already picked one for this week
        const existingSelection = await prisma.selectedHistoricalPaper.findFirst({
            where: {
                topic: topic.toLowerCase(),
                weekStart: weekStart,
            }
        });

        if (existingSelection) {
            // Fetch that specific paper's details from arxiv
            const baseUrl = process.env.NEXTAUTH_URL || `http://localhost:${process.env.PORT || 3000}`;
            const res = await fetch(`http://export.arxiv.org/api/query?id_list=${existingSelection.arxivId}`);

            if (res.ok) {
                const xml = await res.text();
                // Simple parsing or just use the local route structure to make it easier, but we need details
                // For simplicity, let's query the main route with a special query or just parse the XML directly here?
                // Extract proper entry to avoid matching feed title
                const entries = xml.split('<entry>');
                if (entries.length > 1) {
                    const entry = entries[1]; // First entry after XML feed header
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
                            source: 'ArXiv Historical Selection',
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
            // If failed to fetch, fall back to searching a new one maybe?
        }

        // We need a new historical paper. Pick one from 3 to 30 years ago to find truly historical papers
        const yearsAgo = Math.floor(Math.random() * 28) + 3; // 3 to 30 years ago
        const pastDate = new Date(now);
        pastDate.setFullYear(now.getFullYear() - yearsAgo);

        const dateFromStr = `${pastDate.getFullYear()}01010000`; // First day of that year
        const dateToStr = `${pastDate.getFullYear()}12312359`; // Last day of that year

        let arxivQuery = `cat:cs.AI`;
        if (topic.toLowerCase() === 'crypto') arxivQuery = `all:crypto`;
        if (topic.toLowerCase() === 'space') arxivQuery = `all:space`;

        const fullQuery = `${arxivQuery} AND submittedDate:[${dateFromStr} TO ${dateToStr}]`;
        const fetchUrl = `http://export.arxiv.org/api/query?search_query=${encodeURIComponent(fullQuery)}&start=0&max_results=100&sortBy=relevance&sortOrder=descending`;

        const res2 = await fetch(fetchUrl);
        if (res2.ok) {
            const xml = await res2.text();

            // Extract all entries
            const entries = xml.split('<entry>');
            entries.shift(); // Remove the feed header part

            const dbPicked = await prisma.selectedHistoricalPaper.findMany({
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
                const batchIds = entryRecords.map(r => `ArXiv:${r.id}`);
                // Semantic Scholar limits batch to 500, we have <= 100
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
                    console.error("Error fetching citations for historical sorting", err);
                }

                // Sort by citations descending
                entryRecords.sort((a, b) => b.citations - a.citations);

                const topRecord = entryRecords[0];
                const selectedEntry = topRecord.entry;
                const selectedId = topRecord.id;

                // Save it to DB
                await prisma.selectedHistoricalPaper.create({
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
                    source: 'ArXiv Historical Selection',
                    arxivId: selectedId,
                    upvotes: 0,
                    citationCount: topRecord.citations
                };

                return NextResponse.json([mappedPaper]);
            }
        }

        return NextResponse.json([]);
    } catch (error: any) {
        console.error(`Error in historical research API:`, error);
        return NextResponse.json({ error: 'Failed to fetch historical paper', details: error.toString(), stack: error.stack }, { status: 500 });
    }
}

// Cache historical responses for an hour (so it doesn't query the DB endlessly per refresh)
export const GET = withCache(getHandler, 3600);
