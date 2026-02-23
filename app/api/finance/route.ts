import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { withCache } from '../../../lib/cache';

// CoinGecko markets API for top 100
const COINGECKO_TOP100_URL = 'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&sparkline=false&price_change_percentage=24h';
const COINGECKO_PRICES_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana&vs_currencies=usd&include_24hr_change=true';
const MEMPOOL_FEES_URL = 'https://mempool.space/api/v1/fees/recommended';

async function getHandler() {
    try {
        const [top100Res, pricesRes, feesRes] = await Promise.all([
            fetch(COINGECKO_TOP100_URL, {
                next: { revalidate: 300 }, // Cache for 5 mins
            }),
            fetch(COINGECKO_PRICES_URL, {
                next: { revalidate: 300 }, // Cache for 5 mins
            }),
            fetch(MEMPOOL_FEES_URL, {
                next: { revalidate: 300 }, // Cache for 5 mins
            })
        ]);

        if (!top100Res.ok || !pricesRes.ok || !feesRes.ok) {
            throw new Error(`Failed to fetch crypto data`);
        }

        const top100Data = await top100Res.json();
        const pricesData = await pricesRes.json();
        const feesData = await feesRes.json();

        // Log the prices to our database (acts like our job runner since it runs on request)
        if (pricesData.bitcoin?.usd) {
            await prisma.cryptoPrice.create({
                data: {
                    coinId: "bitcoin",
                    price: pricesData.bitcoin.usd
                }
            });
        }

        // Fetch historical data for chart (latest 288 points = approx 24h if polled every 5 min)
        const btcHistory = await prisma.cryptoPrice.findMany({
            where: { coinId: "bitcoin" },
            orderBy: { timestamp: "desc" },
            take: 288
        });

        // Reverse to chronological order for chart
        btcHistory.reverse();

        // Extract top 100 coins
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const top100Coins = top100Data.map((item: any) => ({
            id: item.id,
            name: item.name,
            symbol: item.symbol,
            marketCapRank: item.market_cap_rank,
            image: item.image,
            currentPrice: item.current_price,
            priceChange24h: item.price_change_percentage_24h,
            marketCap: item.market_cap
        }));

        return NextResponse.json({
            top100: top100Coins,
            prices: {
                bitcoin: {
                    usd: pricesData.bitcoin.usd,
                    usd_24h_change: pricesData.bitcoin.usd_24h_change,
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    history: btcHistory.map((h: any) => ({ time: h.timestamp, price: h.price }))
                },
                ethereum: {
                    usd: pricesData.ethereum.usd,
                },
                solana: {
                    usd: pricesData.solana.usd,
                }
            },
            fees: feesData,
            timestamp: Date.now()
        });
    } catch (error) {
        console.error('Error fetching finance/crypto data:', error);
        return NextResponse.json({ error: 'Failed to fetch finance data' }, { status: 500 });
    }
}

export const GET = withCache(getHandler, 300); // 5 minutes TTL
