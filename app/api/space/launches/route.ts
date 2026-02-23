import { NextResponse } from 'next/server';
import { withCache } from '../../../../lib/cache';

const LAUNCH_API_URL = 'https://ll.thespacedevs.com/2.2.0/launch/upcoming/?limit=102';

async function getHandler() {
    try {
        const res = await fetch(LAUNCH_API_URL, {
            next: { revalidate: 21600 }, // Cache for 6 hours
            headers: {
                'User-Agent': 'MissionControl/1.0',
            }
        });

        if (!res.ok) {
            throw new Error(`Failed to fetch upcoming launches: ${res.status}`);
        }

        const data = await res.json();
        return NextResponse.json(data.results);
    } catch (error) {
        console.error('Error fetching upcoming launches:', error);
        return NextResponse.json({ error: 'Failed to fetch upcoming launches' }, { status: 500 });
    }
}

export const GET = withCache(getHandler, 21600);
