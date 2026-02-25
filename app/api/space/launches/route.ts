import { NextResponse } from 'next/server';
import { withCache } from '../../../../lib/cache';

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

        const res = await fetch(url, {
            next: { revalidate: 21600 }, // Cache for 6 hours
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

export const GET = withCache(getHandler, 21600);
