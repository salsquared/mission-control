import { NextResponse } from 'next/server';
import { withCache } from '../../../lib/cache';

const SPAM_COIN_IDS = new Set([
    'figure-heloc', 'whitebit', 'whitebit-coin', 'eutbl', 'canton-network',
    'blackrock-usd-institutional-digital-liquidity-fund', 'hashnote-usyc',
    'falcon-finance', 'superstate-short-duration-us-government-securities-fund-ustb',
    'usdtb', 'ousg', 'janus-henderson-anemoy-aaa-clo-fund', 'janus-henderson-anemoy-treasury-fund',
]);

function getPulsarUrl() {
    const url = process.env.PULSAR_URL;
    if (!url) throw new Error('PULSAR_URL env var is not set. Add it to .env.development / .env.production.');
    return url;
}

function adaptPulsarToFinanceShape(ticks: any[]) {
    const top100 = ticks
        .filter((t: any) => !SPAM_COIN_IDS.has(t.assetId))
        .map((t: any) => ({
            id: t.assetId,
            name: t.name ?? t.assetId,
            symbol: t.symbol ?? t.assetId,
            marketCapRank: t.marketCapRank ?? null,
            image: t.image ?? '',
            currentPrice: t.close,
            priceChange24h: t.change24h ?? 0,
            marketCap: t.marketCap ?? 0,
        }));

    const find = (id: string) => ticks.find((t: any) => t.assetId === id) ?? {};
    const btc = find('bitcoin');
    const eth = find('ethereum');
    const sol = find('solana');

    const prices = {
        bitcoin: { usd: btc.close ?? 0, usd_24h_change: btc.change24h ?? 0 },
        ethereum: { usd: eth.close ?? 0 },
        solana: { usd: sol.close ?? 0 },
    };

    // Fees are served by a separate Pulsar endpoint; include as empty object here.
    // The Mempool fees route is swapped in the same task below.
    const fees = btc.fees ?? {};

    return { top100, prices, fees, timestamp: Date.now() };
}

async function getHandler() {
    const pulsarUrl = getPulsarUrl();
    console.info(`[EXTERNAL API] Fetching from Pulsar: ${pulsarUrl}/api/prices/latest?class=crypto`);

    const [pricesRes, feesRes] = await Promise.all([
        fetch(`${pulsarUrl}/api/prices/latest?class=crypto`),
        fetch(`${pulsarUrl}/api/prices/latest?class=mempool`).catch(() => null),
    ]);

    if (!pricesRes.ok) {
        throw new Error(`Pulsar /api/prices/latest returned ${pricesRes.status}`);
    }

    const ticks = await pricesRes.json();
    const feesData = feesRes?.ok ? await feesRes.json() : {};

    const shape = adaptPulsarToFinanceShape(Array.isArray(ticks) ? ticks : []);

    // If Pulsar has a dedicated mempool/fees tick, surface it
    if (feesData && Object.keys(feesData).length > 0) {
        shape.fees = feesData;
    }

    return NextResponse.json(shape);
}

export const GET = withCache(getHandler, 300); // 5-minute TTL
