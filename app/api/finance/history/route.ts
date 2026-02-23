import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const range = searchParams.get('range') || '1'; // default to 1 day
    const coin = searchParams.get('coin') || 'bitcoin';

    if (range === 'max') {
        try {
            // First, get all the prices for the coin from our database, sorted chronologically
            const allPrices = await prisma.cryptoPrice.findMany({
                where: { coinId: coin },
                orderBy: { timestamp: 'asc' }
            });

            if (allPrices.length === 0) {
                return NextResponse.json({ history: [] });
            }

            // To avoid UI lag with 4000+ data points, we downsample the array to ~500 points
            // This is roughly equivalent to a 1-week interval over 10-15 years
            const maxPoints = 500;
            const step = Math.max(1, Math.floor(allPrices.length / maxPoints));

            const history: { time: number; price: number }[] = [];
            for (let i = 0; i < allPrices.length; i += step) {
                history.push({
                    time: allPrices[i].timestamp.getTime(),
                    price: allPrices[i].price
                });
            }

            return NextResponse.json({ history });
        } catch (error) {
            console.error('Error fetching max history from database:', error);
            return NextResponse.json({ error: 'Failed to fetch DB max history' }, { status: 500 });
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
