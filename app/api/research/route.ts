import { NextResponse } from 'next/server';
import { withCache } from '../../../lib/cache';
import Parser from 'rss-parser';

const parser = new Parser({
    customFields: {
        item: ['summary', 'author', 'dc:creator', 'content', 'id']
    }
});

async function getHandler(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const topic = searchParams.get('topic') || 'ai';
        const timeframe = searchParams.get('timeframe') || 'yesterday'; // 'yesterday' or 'week'
        const limit = parseInt(searchParams.get('limit') || '5', 10);
        const type = searchParams.get('type'); // 'review' or null

        let initialPapers: any[] = [];

        // 1. Fetch from source based on topic
        if (topic.toLowerCase() === 'ai' && type !== 'review') {
            const hfRes = await fetch('https://huggingface.co/api/daily_papers');
            if (hfRes.ok) {
                const data = await hfRes.json();
                const sorted = data;

                const now = new Date();
                const pad = (n: number) => n.toString().padStart(2, '0');
                const yesterday = new Date(now);
                yesterday.setDate(now.getDate() - 1);
                const yesterdayStr = `${yesterday.getFullYear()}-${pad(yesterday.getMonth() + 1)}-${pad(yesterday.getDate())}`;
                const todayStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

                let sliced = sorted;

                // We must filter strictly by Arxiv publishing date
                if (timeframe === 'yesterday') {
                    sliced = sorted.filter((item: any) => {
                        const paper = item.paper || item;
                        const pubDate = Array.isArray(paper.publishedAt) ? paper.publishedAt[0] : paper.publishedAt;
                        if (!pubDate) return false;
                        return pubDate.startsWith(yesterdayStr);
                    }).slice(0, limit);
                } else {
                    const dayOfWeek = now.getDay() === 0 ? 6 : now.getDay() - 1;
                    const lastWeekStart = new Date(now);
                    lastWeekStart.setDate(now.getDate() - dayOfWeek - 7);
                    lastWeekStart.setHours(0, 0, 0, 0);

                    const lastWeekEnd = new Date(lastWeekStart);
                    lastWeekEnd.setDate(lastWeekStart.getDate() + 6);
                    lastWeekEnd.setHours(23, 59, 59, 999);

                    const weekPapers = sorted.filter((item: any) => {
                        const paper = item.paper || item;
                        const pubDateStr = Array.isArray(paper.publishedAt) ? paper.publishedAt[0] : paper.publishedAt;
                        if (!pubDateStr) return false;
                        const pubDateObj = new Date(pubDateStr);
                        return pubDateObj >= lastWeekStart && pubDateObj <= lastWeekEnd;
                    });

                    // Sort by upvotes descending
                    weekPapers.sort((a: any, b: any) => {
                        const paperA = a.paper || a;
                        const paperB = b.paper || b;
                        return (paperB.upvotes || 0) - (paperA.upvotes || 0);
                    });

                    sliced = weekPapers.slice(0, limit);
                }

                initialPapers = sliced.map((item: any) => {
                    const paper = item.paper || item;
                    return {
                        id: paper.id,
                        title: item.title || paper.title,
                        summary: item.summary || paper.summary,
                        url: `https://arxiv.org/abs/${paper.id}`,
                        author: paper.authors?.[0]?.name || 'Unknown',
                        published_at: item.publishedAt || paper.publishedAt || new Date().toISOString(),
                        source: 'Hugging Face Daily Papers',
                        upvotes: paper.upvotes || 0,
                        arxivId: paper.id
                    };
                });
            }
        } else {
            // Default to Arxiv for topics like Crypto, Space, or for 'review' type AI
            const searchQueryParts: string[] = [];

            if (topic.toLowerCase() === 'ai' || topic.toLowerCase() === 'cs.ai') {
                searchQueryParts.push('cat:cs.AI');
            } else if (topic.toLowerCase() === 'crypto') {
                searchQueryParts.push('all:crypto');
            } else if (topic.toLowerCase() === 'space') {
                searchQueryParts.push('all:space');
            } else {
                searchQueryParts.push(`all:${encodeURIComponent(topic)}`);
            }

            if (type === 'review') {
                searchQueryParts.push('ti:review'); // Simplification mimicking the arxiv local route logic over complex logic
            }

            const now = new Date();
            const pad = (n: number) => n.toString().padStart(2, '0');

            let dateFromStr = "";
            let dateToStr = "";

            if (timeframe === 'yesterday') {
                const yesterday = new Date(now);
                yesterday.setDate(now.getDate() - 1);
                dateFromStr = `${yesterday.getFullYear()}${pad(yesterday.getMonth() + 1)}${pad(yesterday.getDate())}0000`;
                dateToStr = `${yesterday.getFullYear()}${pad(yesterday.getMonth() + 1)}${pad(yesterday.getDate())}2359`;
            } else {
                const searchDays = type === 'review' ? 365 : 7;
                const startDate = new Date(now);
                let endDate = new Date(now);

                if (type !== 'review') {
                    // For the 'week' timeframe, use the previous calendar week (Monday - Sunday)
                    const dayOfWeek = now.getDay() === 0 ? 6 : now.getDay() - 1;
                    startDate.setDate(now.getDate() - dayOfWeek - 7);
                    endDate = new Date(startDate);
                    endDate.setDate(startDate.getDate() + 6);
                } else {
                    startDate.setDate(now.getDate() - searchDays);
                }

                dateFromStr = `${startDate.getFullYear()}${pad(startDate.getMonth() + 1)}${pad(startDate.getDate())}0000`;
                dateToStr = `${endDate.getFullYear()}${pad(endDate.getMonth() + 1)}${pad(endDate.getDate())}2359`;
            }

            searchQueryParts.push(`submittedDate:[${dateFromStr}+TO+${dateToStr}]`);

            const searchQuery = searchQueryParts.join('+AND+');
            const arxivApiUrl = `http://export.arxiv.org/api/query?search_query=${searchQuery}&start=0&max_results=${limit}&sortBy=submittedDate&sortOrder=descending`;

            try {
                const feed = await parser.parseURL(arxivApiUrl);
                initialPapers = feed.items.map(item => {
                    const rawId = item.id || item.link || Math.random().toString();
                    const arxivId = (rawId.split('/abs/')[1] || rawId).replace(/v\d+$/, '');

                    return {
                        id: rawId,
                        title: item.title?.replace(/\n/g, ' ').replace(/\s+/g, ' ') || "arXiv Paper",
                        summary: item.summary?.replace(/\n/g, ' ').trim() || "",
                        url: item.link || "",
                        author: item.author || item['dc:creator'] || 'Unknown',
                        published_at: item.isoDate || item.pubDate || new Date().toISOString(),
                        source: 'arXiv',
                        arxivId: arxivId
                    };
                });
            } catch (err) {
                console.error("Error fetching arxiv feed via rss-parser:", err);
            }
        }

        // 2. Enrich with Semantic Scholar
        if (initialPapers.length > 0) {
            const arxivIds = initialPapers.map(p => `ArXiv:${p.arxivId}`);

            const ssRes = await fetch('https://api.semanticscholar.org/graph/v1/paper/batch?fields=title,authors,abstract,citationCount,year,url', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ids: arxivIds })
            });

            if (ssRes.ok) {
                const ssData = await ssRes.json();

                // Mapped by index since SS returns null for not found
                initialPapers = initialPapers.map((paper, i) => {
                    const ssPaper = ssData[i];
                    if (ssPaper) {
                        return {
                            ...paper,
                            citationCount: ssPaper.citationCount || 0
                        };
                    }
                    return paper;
                });
            }
        }

        return NextResponse.json(initialPapers);
    } catch (error) {
        console.error(`Error in research aggregator API:`, error);
        return NextResponse.json({ error: 'Failed to fetch research papers' }, { status: 500 });
    }
}

// Cache aggregator responses for an hour
export const GET = withCache(getHandler, 3600);
