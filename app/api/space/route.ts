import { NextResponse } from 'next/server';

const SNAPI_URL = 'https://api.spaceflightnewsapi.net/v4/articles/?limit=10';

export async function GET() {
    try {
        const res = await fetch(SNAPI_URL, {
            next: { revalidate: 3600 }, // Cache for 1 hour
        });

        if (!res.ok) {
            throw new Error(`Failed to fetch Spaceflight News: ${res.status}`);
        }

        const data = await res.json();
        return NextResponse.json(data.results);
    } catch (error) {
        console.error('Error fetching space news:', error);
        return NextResponse.json({ error: 'Failed to fetch space news' }, { status: 500 });
    }
}
