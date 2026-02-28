/* eslint-disable */
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { withCache } from '../../../../lib/cache';

async function ingestMaxHistory(coinId: string) {
    const symbolMap: Record<string, string> = {
        'bitcoin': 'BTC-USD',
        'ethereum': 'ETH-USD',
        'solana': 'SOL-USD'
    };
    const ticker = symbolMap[coinId] || `${coinId.toUpperCase()}-USD`;
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=15y`;

    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) {
        console.error(`Failed to fetch max history from Yahoo for ${ticker}`);
        return;
    }

    const data = await res.json();
    const result = data.chart?.result?.[0];
    if (!result || !result.timestamp || !result.indicators?.quote?.[0]?.close) return;

    const timestamps = result.timestamp;
    const closes = result.indicators.quote[0].close;

    const prices: [number, number][] = [];
    for (let i = 0; i < timestamps.length; i++) {
        const time = timestamps[i] * 1000;
        const price = closes[i];
        if (price !== null && price !== undefined) {
            prices.push([time, price]);
        }
    }

    // Get current bounds to avoid direct duplicates
    const bounds = await prisma.cryptoPrice.aggregate({
        where: { coinId },
        _min: { timestamp: true },
        _max: { timestamp: true }
    });

    const minTs = bounds._min.timestamp?.getTime() || Date.now();
    const maxTs = bounds._max.timestamp?.getTime() || 0;

    const toInsert = prices
        .filter(pt => pt[0] < minTs || pt[0] > maxTs)
        .map(pt => ({
            coinId,
            price: pt[1],
            timestamp: new Date(pt[0])
        }));

    if (toInsert.length === 0) return;

    const batchSize = 1000;
    for (let i = 0; i < toInsert.length; i += batchSize) {
        const batch = toInsert.slice(i, i + batchSize);
        await prisma.cryptoPrice.createMany({ data: batch });
    }
}

async function getHandler(request: Request) {
    const { searchParams } = new URL(request.url);
    const range = searchParams.get('range') || '1'; // default to 1 day
    const coin = searchParams.get('coin') || 'bitcoin';

    const rangeDays = parseInt(range);
    const useDb = range === 'max' || (!isNaN(rangeDays) && rangeDays > 365);

    if (useDb) {
        try {
            const now = Date.now();
            const oneYearInMs = 365 * 24 * 60 * 60 * 1000;
            const startTime = range === 'max' ? 0 : now - (rangeDays * 24 * 60 * 60 * 1000);

            // First, get all the prices for the coin from our database, sorted chronologically
            let allPrices = await prisma.cryptoPrice.findMany({
                where: {
                    coinId: coin,
                    ...(range !== 'max' ? { timestamp: { gte: new Date(startTime) } } : {})
                },
                orderBy: { timestamp: 'asc' }
            });

            // Check if we have a "significant" history (at least 1 year span)
            // Even if requesting 5Y, if DB only has a few days, we should ingest Max history first to populate it
            let hasHistory = false;
            if (allPrices.length > 0) {
                const firstPointSpan = await prisma.cryptoPrice.findFirst({
                    where: { coinId: coin },
                    orderBy: { timestamp: 'asc' }
                });
                if (firstPointSpan) {
                    hasHistory = (now - firstPointSpan.timestamp.getTime()) > oneYearInMs;
                }
            }

            if (!hasHistory) {
                console.log(`Insufficient history for ${coin} (span too short or empty). Ingesting from source...`);
                await ingestMaxHistory(coin);

                // Re-fetch now that db is populated
                allPrices = await prisma.cryptoPrice.findMany({
                    where: {
                        coinId: coin,
                        ...(range !== 'max' ? { timestamp: { gte: new Date(startTime) } } : {})
                    },
                    orderBy: { timestamp: 'asc' }
                });
            }

            if (allPrices.length === 0) {
                return NextResponse.json({ history: [] });
            }

            // Group by day to ensure we only have 1 data point per day
            const historyMap = new Map<string, { time: number; price: number }>();
            for (const item of allPrices) {
                const dateKey = item.timestamp.toISOString().split('T')[0];
                historyMap.set(dateKey, {
                    time: item.timestamp.getTime(),
                    price: item.price
                });
            }

            let history = Array.from(historyMap.values());

            // To avoid UI lag with too many days, we downsample the array to ~500 points
            const maxPoints = 500;
            const step = Math.max(1, Math.floor(history.length / maxPoints));

            if (step > 1) {
                const sampled = [];
                for (let i = 0; i < history.length; i += step) {
                    sampled.push(history[i]);
                }
                // Always ensure the very last (most recent) point is included if not already
                const lastPoint = history[history.length - 1];
                if (sampled.length > 0 && sampled[sampled.length - 1].time !== lastPoint.time) {
                    sampled.push(lastPoint);
                }
                history = sampled;
            }

            return NextResponse.json({ history });
        } catch (error) {
            console.error('Error fetching long-range history from database:', error);
            return NextResponse.json({ error: 'Failed to fetch DB history' }, { status: 500 });
        }
    }

    // CoinGecko market_chart API
    const url = `https://api.coingecko.com/api/v3/coins/${coin}/market_chart?vs_currency=usd&days=${range}`;

    try {
        const apiKey = process.env.COINGECKO_API_KEY || '';
        const res = await fetch(url, {
            headers: apiKey ? { 'x-cg-demo-api-key': apiKey } : {},
            next: { revalidate: 300 } // cache for 5 mins
        });

        if (!res.ok) {
            throw new Error(`Failed to fetch history for ${coin}`);
        }

        const data = await res.json();

        if (!data?.prices) {
            throw new Error('Invalid history format');
        }

        // map chart data to our required format
        const history = data.prices.map((pt: [number, number]) => ({
            time: pt[0],
            price: pt[1]
        }));

        return NextResponse.json({ history });
    } catch (error) {
        console.error('Error fetching crypto history:', error);
        return NextResponse.json({ error: 'Failed to fetch history' }, { status: 500 });
    }
}

export const GET = withCache(getHandler as any, 300); // 5 mins TTL
