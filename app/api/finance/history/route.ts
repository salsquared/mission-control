import { NextResponse } from 'next/server';
import { withCache } from '../../../../lib/cache';
import { requireLocalOrSession } from '@/lib/auth-guards';

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
        // Long-range: pre-aggregated DailySummary via /history/:id/summary
        const fromDate = range === 'max'
            ? new Date(0).toISOString()
            : new Date(Date.now() - rangeDays * 86_400_000).toISOString();

        const res = await fetch(`${pulsarUrl}/api/history/${coin}/summary?from=${fromDate}`);
        if (!res.ok) throw new Error(`Pulsar /api/history/${coin}/summary returned ${res.status}`);

        const env = await res.json();
        const rows: any[] = Array.isArray(env?.data) ? env.data : [];

        // Pulsar OhlcvPoint shape: { t (ISO), o, h, l, c, v }
        const history = rows.map((r) => ({
            time: new Date(r.t).getTime(),
            price: r.c,
        }));

        // Downsample to ~500 points
        const step = Math.max(1, Math.floor(history.length / 500));
        const sampled = history.filter((_, i) => i % step === 0);
        if (sampled.length > 0 && sampled[sampled.length - 1].time !== history[history.length - 1]?.time) {
            sampled.push(history[history.length - 1]);
        }

        return NextResponse.json({ history: sampled });
    }

    // Short-range: hourly OHLCV bars via /history/:id?interval=1h
    const from = new Date(Date.now() - rangeDays * 86_400_000).toISOString();
    const to = new Date().toISOString();
    const res = await fetch(`${pulsarUrl}/api/history/${coin}?from=${from}&to=${to}&interval=1h`);

    if (!res.ok) throw new Error(`Pulsar /api/history/${coin} returned ${res.status}`);

    const env = await res.json();
    const rows: any[] = Array.isArray(env?.data) ? env.data : [];

    const history = rows.map((r) => ({
        time: new Date(r.t).getTime(),
        price: r.c,
    }));

    return NextResponse.json({ history });
}

function pulsarHost(): string | null {
    try { return new URL(process.env.PULSAR_URL ?? '').hostname || null; } catch { return null; }
}

const cachedGET = withCache(getHandler as any, { ttlSeconds: 300, upstreamHost: pulsarHost }); // 5-minute TTL
export const GET = async (req: Request) => {
    const guard = await requireLocalOrSession(req);
    if ('error' in guard) return guard.error;
    return cachedGET(req);
};
