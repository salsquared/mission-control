/**
 * ingest-btc-history.ts
 * 
 * Purpose: Full History / Incremental Backfill.
 * This script is meant to populate the full historical record of Bitcoin and keep it updated.
 * It fetches the maximum available history from CoinGecko.
 * It queries the database for the most recent data point and only inserts new data points 
 * that occurred after that timestamp, preserving existing data and avoiding duplicates.
 * Data is inserted in batches to handle large payloads efficiently.
 */

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    console.log('Fetching BTC history from Yahoo Finance...');
    // Yahoo Finance API provides up to max history at daily intervals if we ask for 15y
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/BTC-USD?interval=1d&range=15y';

    // Add User-Agent to prevent 403 Forbidden
    const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' }
    });

    if (!res.ok) {
        throw new Error(`Failed to fetch history: ${res.status} ${res.statusText}`);
    }

    const data = await res.json();
    const result = data.chart?.result?.[0];

    if (!result || !result.timestamp || !result.indicators?.quote?.[0]?.close) {
        throw new Error('Invalid history format from Yahoo Finance');
    }

    const timestamps = result.timestamp;
    const closes = result.indicators.quote[0].close;

    // Combine timestamp and close prices. Yahoo timestamp is in seconds, so multiply by 1000
    const prices: [number, number][] = [];
    for (let i = 0; i < timestamps.length; i++) {
        const time = timestamps[i] * 1000;
        const price = closes[i];
        if (price !== null && price !== undefined) {
            prices.push([time, price]);
        }
    }

    console.log(`Fetched ${prices.length} price points.`);

    const existingCount = await prisma.cryptoPrice.count({
        where: { coinId: 'bitcoin' }
    });
    console.log(`Existing DB points: ${existingCount}`);

    // Get the earliest and latest timestamp in DB to avoid dupes while allowing backfill
    const earliest = await prisma.cryptoPrice.findFirst({
        where: { coinId: 'bitcoin' },
        orderBy: { timestamp: 'asc' }
    });
    const latest = await prisma.cryptoPrice.findFirst({
        where: { coinId: 'bitcoin' },
        orderBy: { timestamp: 'desc' }
    });

    const earliestTs = earliest ? earliest.timestamp.getTime() : Date.now();
    const latestTs = latest ? latest.timestamp.getTime() : 0;

    const toInsert = prices
        .filter((pt: [number, number]) => pt[0] < earliestTs || pt[0] > latestTs)
        .map((pt: [number, number]) => ({
            coinId: 'bitcoin',
            price: pt[1],
            timestamp: new Date(pt[0])
        }));

    console.log(`Inserting ${toInsert.length} new points...`);

    // Insert in batches
    const batchSize = 1000;
    for (let i = 0; i < toInsert.length; i += batchSize) {
        const batch = toInsert.slice(i, i + batchSize);
        await prisma.cryptoPrice.createMany({
            data: batch
        });
        console.log(`Inserted batch ${i} to ${i + batchSize}`);
    }

    console.log('Finished ingesting BTC history.');
}

main()
    .catch(e => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
