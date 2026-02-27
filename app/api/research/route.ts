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
                    const lastWeek = new Date(now);
                    lastWeek.setDate(now.getDate() - 7);
                    sliced = sorted.filter((item: any) => {
                        const paper = item.paper || item;
                        const pubDate = Array.isArray(paper.publishedAt) ? paper.publishedAt[0] : paper.publishedAt;
                        if (!pubDate) return false;
                        return new Date(pubDate) >= lastWeek && !pubDate.startsWith(yesterdayStr);
                    }).slice(0, limit);
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
            let searchQueryParts: string[] = [];

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
                const lastWeek = new Date(now);
                lastWeek.setDate(now.getDate() - searchDays);
                dateFromStr = `${lastWeek.getFullYear()}${pad(lastWeek.getMonth() + 1)}${pad(lastWeek.getDate())}0000`;
                dateToStr = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}2359`;
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
