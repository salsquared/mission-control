import { NextResponse } from 'next/server';

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const range = searchParams.get('range') || '1'; // default to 1 day
    const coin = searchParams.get('coin') || 'bitcoin';

    // CoinGecko market_chart API
    const url = `https://api.coingecko.com/api/v3/coins/${coin}/market_chart?vs_currency=usd&days=${range}`;

    try {
        const res = await fetch(url, {
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
