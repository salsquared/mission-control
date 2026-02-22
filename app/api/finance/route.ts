import { NextResponse } from 'next/server';

// CoinGecko trending API is free and requires no key
const COINGECKO_TRENDING_URL = 'https://api.coingecko.com/api/v3/search/trending';

export async function GET() {
    try {
        const res = await fetch(COINGECKO_TRENDING_URL, {
            next: { revalidate: 1800 }, // Cache for 30 mins
        });

        if (!res.ok) {
            throw new Error(`Failed to fetch crypto trending data: ${res.status}`);
        }

        const data = await res.json();

        // Extract top 7 trending coins
        const trendingCoins = data.coins.slice(0, 7).map((item: any) => ({
            id: item.item.id,
            name: item.item.name,
            symbol: item.item.symbol,
            marketCapRank: item.item.market_cap_rank,
            thumb: item.item.thumb,
            priceBtc: item.item.price_btc,
        }));

        return NextResponse.json(trendingCoins);
    } catch (error) {
        console.error('Error fetching finance/crypto data:', error);
        return NextResponse.json({ error: 'Failed to fetch finance data' }, { status: 500 });
    }
}
