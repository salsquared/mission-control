import { NextResponse } from 'next/server';
import { withCache } from '../../../../lib/cache';
import { requireLocalOrSession } from '@/lib/auth-guards';

async function getHandler(req: Request) {
    try {
        const urlObj = new URL(req.url);
        const year = urlObj.searchParams.get('year');
        const month = urlObj.searchParams.get('month');

        let url = 'https://ll.thespacedevs.com/2.2.0/launch/upcoming/?limit=102';

        if (year && month) {
            // Month is 1-indexed (1 = January, 12 = December)
            const startDate = new Date(Date.UTC(Number(year), Number(month) - 1, 1));
            // Get last day of the month
            const endDate = new Date(Date.UTC(Number(year), Number(month), 0, 23, 59, 59));

            const gte = startDate.toISOString();
            const lte = endDate.toISOString();

            url = `https://ll.thespacedevs.com/2.2.0/launch/?limit=100&net__gte=${gte}&net__lte=${lte}`;
        }

        console.info(`[EXTERNAL API] Fetching from The Space Devs (Launches): ${url}`);
        const res = await fetch(url, {
            cache: 'no-store', // Let withCache handle the caching to prevent stale-while-revalidate overlap
            headers: {
                'User-Agent': 'MissionControl/1.0',
            }
        });

        if (!res.ok) {
            throw new Error(`Failed to fetch launches: ${res.status}`);
        }

        const data = await res.json();
        return NextResponse.json(data.results);
    } catch (error) {
        console.error('Error fetching launches:', error);
        return NextResponse.json({ error: 'Failed to fetch launches' }, { status: 500 });
    }
}

const cachedGET = withCache(getHandler, { ttlSeconds: 1800, upstreamHost: 'll.thespacedevs.com' });
export const GET = async (req: Request) => {
    const guard = await requireLocalOrSession(req);
    if ('error' in guard) return guard.error;
    return cachedGET(req);
};
