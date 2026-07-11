import { NextRequest, NextResponse } from 'next/server';
import axios from 'axios';
import { requireLocalOrSession } from '@/lib/auth-guards';
import { parseLmarenaLeaderboard } from '@/lib/ai/lmarena-leaderboard';
import { harvestOrgLogos } from '@/lib/ai/org-logos';

export const revalidate = 3600; // Cache for 1 hour

export async function GET(req: NextRequest) {
    const guard = await requireLocalOrSession(req);
    if ('error' in guard) return guard.error;
    try {
        const { searchParams } = new URL(req.url);
        const category = searchParams.get('category') || 'text';

        const url = `https://lmarena.ai/leaderboard/${category}`;
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        });

        const models = parseLmarenaLeaderboard(response.data, url);

        // Fire-and-forget: sanitize + persist logo files for any org that
        // doesn't have one yet (hourly-debounced per category, best-effort)
        // so new companies get a real logo instead of the initials badge.
        void harvestOrgLogos(response.data, { category });

        return NextResponse.json(models);

    } catch (error) {
        console.error("Failed to fetch LLM leaderboard from Arena:", error);
        return NextResponse.json({ error: "Failed to fetch leaderboard" }, { status: 500 });
    }
}
