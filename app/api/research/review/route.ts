import { NextResponse } from 'next/server';
import { withCache } from '../../../../lib/cache';
import { requireLocalOrSession } from '@/lib/auth-guards';
import { acquireArxivSlot } from '@/lib/arxiv/rate-limit';
import { loggedFetch } from '@/lib/external-fetch';
import {
    findCurrentReviewPick,
    listPickedReviewIds,
    recordReviewPick,
    backfillReviewPick,
} from '@/lib/repositories/selected-papers';

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
        const existingSelection = await findCurrentReviewPick(topic.toLowerCase(), weekStart);

        if (existingSelection) {
            // Fast path (Layer 2): metadata cached at pick time → 0 arXiv/SS calls.
            if (existingSelection.title) {
                const mappedPaper = {
                    id: `http://arxiv.org/abs/${existingSelection.paperId}`,
                    title: existingSelection.title,
                    summary: existingSelection.summary ?? '',
                    url: existingSelection.url ?? `https://arxiv.org/abs/${existingSelection.paperId}`,
                    author: existingSelection.author ?? 'Unknown',
                    published_at: existingSelection.publishedAt
                        ? existingSelection.publishedAt.toISOString()
                        : new Date().toISOString(),
                    source: 'Weekly Recommended Review',
                    paperId: existingSelection.paperId,
                    citationCount: existingSelection.citationCount ?? 0,
                };
                return NextResponse.json([mappedPaper]);
            }

            // Legacy row (pre-backfill, NULL metadata): one id_list fetch, then
            // backfill so the next render is free.
            await acquireArxivSlot();
            const res = await loggedFetch(`https://export.arxiv.org/api/query?id_list=${existingSelection.paperId}`);

            // Throw on non-ok (e.g. 429 "Rate exceeded.") so withCache STALE-FALLBACKs
            // to the last good response instead of falling through to a new search,
            // which would also be throttled AND would overwrite the user's pick.
            if (!res.ok) {
                throw new Error(`arXiv responded ${res.status} ${res.statusText} for id_list=${existingSelection.paperId}`);
            }
            {
                const xml = await res.text();
                // arxiv sometimes returns plaintext "Rate exceeded." with HTTP 200 too.
                if (!xml.trimStart().startsWith('<')) {
                    throw new Error(`arXiv non-XML response (likely rate-limited): ${xml.slice(0, 80)}`);
                }
                // Extract proper entry
                const entries = xml.split('<entry>');
                if (entries.length > 1) {
                    const entry = entries[1]; // First entry after header

                    const titleMatch = entry.match(/<title>([\s\S]*?)<\/title>/);
                    const summaryMatch = entry.match(/<summary>([\s\S]*?)<\/summary>/);
                    const authorMatch = entry.match(/<author>\s*<name>([\s\S]*?)<\/name>/);
                    const publishedMatch = entry.match(/<published>([\s\S]*?)<\/published>/);

                    if (titleMatch && summaryMatch) {
                        const title = titleMatch[1].trim().replace(/\n/g, ' ');
                        const summary = summaryMatch[1].trim();
                        const url = `https://arxiv.org/abs/${existingSelection.paperId}`;
                        const author = authorMatch ? authorMatch[1].trim() : 'Unknown';
                        const publishedIso = publishedMatch ? publishedMatch[1].trim() : new Date().toISOString();
                        const mappedPaper: any = {
                            id: `http://arxiv.org/abs/${existingSelection.paperId}`,
                            title,
                            summary,
                            url,
                            author,
                            published_at: publishedIso,
                            source: 'Weekly Recommended Review',
                            paperId: existingSelection.paperId
                        };

                        // fetch Semantic scholar details
                        const ssRes = await loggedFetch('https://api.semanticscholar.org/graph/v1/paper/batch?fields=title,authors,abstract,citationCount,year,url', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ ids: [`ArXiv:${existingSelection.paperId}`] })
                        });

                        let citationCount: number | null = null;
                        if (ssRes.ok) {
                            const ssData = await ssRes.json();
                            if (ssData[0]) {
                                citationCount = ssData[0].citationCount || 0;
                                mappedPaper.citationCount = citationCount;
                            }
                        }

                        // Backfill so the next render skips arXiv + SS entirely.
                        await backfillReviewPick(existingSelection.paperId, topic.toLowerCase(), {
                            title, summary, url, author,
                            publishedAt: new Date(publishedIso),
                            citationCount,
                        });

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
        if (topic.toLowerCase() === 'physics') arxivQuery = `all:physics`;

        const fullQuery = `${arxivQuery} AND (ti:review OR ti:survey) AND submittedDate:[${dateFromStr} TO ${dateToStr}]`;
        const fetchUrl = `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(fullQuery)}&start=0&max_results=50&sortBy=relevance&sortOrder=descending`;

        await acquireArxivSlot();
        const res = await loggedFetch(fetchUrl);
        if (!res.ok) {
            throw new Error(`arXiv responded ${res.status} ${res.statusText} for ${fullQuery}`);
        }
        {
            const xml = await res.text();
            if (!xml.trimStart().startsWith('<')) {
                throw new Error(`arXiv non-XML response (likely rate-limited): ${xml.slice(0, 80)}`);
            }

            // Extract all entries
            const entries = xml.split('<entry>');
            entries.shift(); // Remove the feed header part

            const pickedIds = new Set(await listPickedReviewIds(topic.toLowerCase()));

            // Extract IDs from all entries
            const entryRecords: { entry: string, id: string, citations: number }[] = [];
            for (const entry of entries) {
                const idMatch = entry.match(/<id>http:\/\/arxiv\.org\/abs\/(.+?)<\/id>/) || entry.match(/<id>http:\/\/arxiv\.org\/abs\/(.+?)v\d+<\/id>/);
                if (idMatch) {
                    const paperId = idMatch[1].split('v')[0]; // Strip version if any
                    if (!pickedIds.has(paperId)) {
                        entryRecords.push({ entry, id: paperId, citations: 0 });
                    }
                }
            }

            if (entryRecords.length > 0) {
                // Batch fetch citations for these candidates
                // Semantic Scholar limits batch to 500, but we only have <= 50
                const batchIds = entryRecords.map(r => `ArXiv:${r.id}`);
                try {
                    const ssRes = await loggedFetch('https://api.semanticscholar.org/graph/v1/paper/batch?fields=citationCount', {
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

                // Parse it
                const titleMatch = selectedEntry.match(/<title>([\s\S]*?)<\/title>/);
                const summaryMatch = selectedEntry.match(/<summary>([\s\S]*?)<\/summary>/);
                const authorMatch = selectedEntry.match(/<author>\s*<name>([\s\S]*?)<\/name>/);
                const publishedMatch = selectedEntry.match(/<published>([\s\S]*?)<\/published>/);

                const title = titleMatch ? titleMatch[1].trim().replace(/\n/g, ' ') : 'Unknown Title';
                const summary = summaryMatch ? summaryMatch[1].trim() : 'No summary';
                const url = `https://arxiv.org/abs/${selectedId}`;
                const author = authorMatch ? authorMatch[1].trim() : 'Unknown';
                const publishedIso = publishedMatch ? publishedMatch[1].trim() : new Date().toISOString();

                // Save it to DB WITH cached metadata so re-renders skip arXiv + SS (Layer 2).
                await recordReviewPick(selectedId, topic.toLowerCase(), weekStart, {
                    title, summary, url, author,
                    publishedAt: new Date(publishedIso),
                    citationCount: topRecord.citations,
                });

                const mappedPaper = {
                    id: `http://arxiv.org/abs/${selectedId}`,
                    title,
                    summary,
                    url,
                    author,
                    published_at: publishedIso,
                    source: 'Weekly Recommended Review',
                    paperId: selectedId,
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

// Cache responses for 24h (weekly pick; metadata served from DB anyway — Layer 2 / OQ6).
// Primary upstream is arXiv (Semantic Scholar is secondary enrichment).
const cachedGET = withCache(getHandler, { ttlSeconds: 86400, upstreamHost: 'export.arxiv.org' });
export const GET = async (req: Request) => {
    const guard = await requireLocalOrSession(req);
    if ('error' in guard) return guard.error;
    return cachedGET(req);
};
