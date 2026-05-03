import { NextResponse } from 'next/server';
import { withCache } from '../../../../lib/cache';

function getPulsarUrl() {
    const url = process.env.PULSAR_URL;
    if (!url) throw new Error('PULSAR_URL env var is not set. Add it to .env.development / .env.production.');
    return url;
}

async function getHandler(request: Request) {
    const { searchParams } = new URL(request.url);
    const range = searchParams.get('range') || '1';
    const coin = searchParams.get('coin') || 'bitcoin';
    const pulsarUrl = getPulsarUrl();

    const rangeDays = parseInt(range);
    const useSummary = range === 'max' || (!isNaN(rangeDays) && rangeDays > 30);

    if (useSummary) {
        // Long-range: use Pulsar's pre-aggregated DailySummary rows
        const fromDate = range === 'max'
            ? new Date(0).toISOString()
            : new Date(Date.now() - rangeDays * 24 * 60 * 60 * 1000).toISOString();

        const url = `${pulsarUrl}/api/history/${coin}/summary?from=${fromDate}`;
        console.info(`[EXTERNAL API] Fetching from Pulsar (summary): ${url}`);
        const res = await fetch(url);

        if (!res.ok) {
            throw new Error(`Pulsar /api/history/${coin}/summary returned ${res.status}`);
        }

        const rows: any[] = await res.json();

        // DailySummary rows have { date, open, high, low, close, volume }
        const history = rows.map((r: any) => ({
            time: new Date(r.date).getTime(),
            price: r.close,
        }));

        // Downsample to ~500 points
        const step = Math.max(1, Math.floor(history.length / 500));
        const sampled = history.filter((_: any, i: number) => i % step === 0);
        if (sampled.length > 0 && sampled[sampled.length - 1].time !== history[history.length - 1]?.time) {
            sampled.push(history[history.length - 1]);
        }

        return NextResponse.json({ history: sampled });
    }

    // Short-range: use Pulsar's tick-level OHLCV history
    const from = new Date(Date.now() - rangeDays * 24 * 60 * 60 * 1000).toISOString();
    const to = new Date().toISOString();
    const url = `${pulsarUrl}/api/history/${coin}?from=${from}&to=${to}&interval=1h`;

    console.info(`[EXTERNAL API] Fetching from Pulsar (history): ${url}`);
    const res = await fetch(url);

    if (!res.ok) {
        throw new Error(`Pulsar /api/history/${coin} returned ${res.status}`);
    }

    const rows: any[] = await res.json();
    const history = rows.map((r: any) => ({
        time: new Date(r.timestamp ?? r.time ?? r.date).getTime(),
        price: r.close,
    }));

    return NextResponse.json({ history });
}

export const GET = withCache(getHandler as any, 300); // 5-minute TTL
