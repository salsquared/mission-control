import { NextResponse } from 'next/server';
import { withSharedCache, researchSharedStore } from '@/lib/research/shared-cache';
import { requireLocalOrSession } from '@/lib/auth-guards';
import { loggedFetch } from '@/lib/external-fetch';

async function getHandler(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const limit = parseInt(searchParams.get('limit') || '10', 10);

        const res = await loggedFetch('https://huggingface.co/api/daily_papers', {
            headers: {
                'User-Agent': 'mission-control-app'
            }
        });

        if (!res.ok) {
            throw new Error(`HF API responded with status ${res.status}`);
        }

        const data = await res.json();

        // Data is an array of objects like { paper: { id, title, summary, authors, upvotes ... }, publishedAt, title, summary }
        const papers = data.slice(0, limit).map((item: any) => {
            const paper = item.paper || item;
            return {
                id: paper.id, // e.g. "2602.16729"
                title: item.title || paper.title,
                summary: item.summary || paper.summary,
                url: `https://arxiv.org/abs/${paper.id}`,
                author: paper.authors?.[0]?.name || 'Unknown',
                published_at: item.publishedAt || paper.publishedAt || new Date().toISOString(),
                source: 'Hugging Face Daily Papers',
                upvotes: paper.upvotes || 0,
            };
        });

        return NextResponse.json(papers);
    } catch (error) {
        console.error(`Error fetching HF papers:`, error);
        return NextResponse.json({ error: 'Failed to fetch Hugging Face papers' }, { status: 500 });
    }
}

// Cache HF responses for an hour; cross-tier shared so dev+prod don't each fetch (Layer 1, OQ2).
const cachedGET = withSharedCache(getHandler, { ttlSeconds: 3600, store: researchSharedStore, upstreamHost: 'huggingface.co' });
export const GET = async (req: Request) => {
    const guard = await requireLocalOrSession(req);
    if ('error' in guard) return guard.error;
    return cachedGET(req);
};
