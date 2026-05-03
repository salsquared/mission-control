import { NextResponse } from 'next/server';
import { withCache } from '../../../lib/cache';

const SPAM_COIN_IDS = new Set([
    'figure-heloc', 'whitebit', 'whitebit-coin', 'eutbl', 'canton-network',
    'blackrock-usd-institutional-digital-liquidity-fund', 'hashnote-usyc',
    'falcon-finance', 'superstate-short-duration-us-government-securities-fund-ustb',
    'usdtb', 'ousg', 'janus-henderson-anemoy-aaa-clo-fund', 'janus-henderson-anemoy-treasury-fund',
]);

// Bitcoin fee tier asset IDs auto-registered by Pulsar's mempool source.
// They appear in /prices/latest?class=CRYPTO but are not coins — exclude from top100.
const BTC_FEE_IDS = new Set(['btc-fee-fast', 'btc-fee-30min', 'btc-fee-eco']);

function getPulsarUrl() {
    const url = process.env.PULSAR_URL;
    if (!url) throw new Error('PULSAR_URL env var is not set. Add it to .env.development / .env.production.');
    return url;
}

async function extractFeeClose(res: Response | null): Promise<number | null> {
    if (!res?.ok) return null;
    const env = await res.json().catch(() => null);
    return env?.data?.close ?? null;
}

async function getHandler() {
    const pulsarUrl = getPulsarUrl();

    // Pulsar's mempool source uses three CRYPTO assetIds. Fees fetched per asset.
    const [pricesRes, btcFastRes, btc30Res, btcEcoRes] = await Promise.all([
        fetch(`${pulsarUrl}/api/prices/latest?class=CRYPTO`),
        fetch(`${pulsarUrl}/api/prices/btc-fee-fast`).catch(() => null),
        fetch(`${pulsarUrl}/api/prices/btc-fee-30min`).catch(() => null),
        fetch(`${pulsarUrl}/api/prices/btc-fee-eco`).catch(() => null),
    ]);

    if (!pricesRes.ok) {
        throw new Error(`Pulsar /api/prices/latest returned ${pricesRes.status}`);
    }

    // Pulsar wraps responses in { meta, data: PricePoint[] }
    const pricesEnv = await pricesRes.json();
    const ticks: any[] = Array.isArray(pricesEnv?.data) ? pricesEnv.data : [];

    const top100 = ticks
        .filter((t) => !SPAM_COIN_IDS.has(t.assetId) && !BTC_FEE_IDS.has(t.assetId))
        .map((t, i) => ({
            id: t.assetId,
            name: t.name ?? t.assetId,
            symbol: t.symbol ?? t.assetId,
            marketCapRank: i + 1,                  // ordered by Pulsar's market_cap_desc fetch
            image: '',                              // Pulsar doesn't store image URLs (yet)
            currentPrice: t.close,
            priceChange24h: t.change24h ?? 0,
            marketCap: 0,                           // Pulsar doesn't store market cap (yet)
        }));

    const find = (id: string) => ticks.find((t) => t.assetId === id) ?? {};
    const btc = find('bitcoin');
    const eth = find('ethereum');
    const sol = find('solana');

    const prices = {
        bitcoin: { usd: btc.close ?? 0, usd_24h_change: btc.change24h ?? 0 },
        ethereum: { usd: eth.close ?? 0 },
        solana: { usd: sol.close ?? 0 },
    };

    const [fastestFee, halfHourFee, economyFee] = await Promise.all([
        extractFeeClose(btcFastRes),
        extractFeeClose(btc30Res),
        extractFeeClose(btcEcoRes),
    ]);

    const fees: Record<string, number> = {};
    if (fastestFee !== null) fees.fastestFee = fastestFee;
    if (halfHourFee !== null) fees.halfHourFee = halfHourFee;
    if (economyFee !== null) fees.economyFee = economyFee;

    return NextResponse.json({ top100, prices, fees, timestamp: Date.now() });
}

function pulsarHost(): string | null {
    try { return new URL(process.env.PULSAR_URL ?? '').hostname || null; } catch { return null; }
}

export const GET = withCache(getHandler, { ttlSeconds: 300, upstreamHost: pulsarHost }); // 5-minute TTL
