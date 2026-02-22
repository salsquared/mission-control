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

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    console.log('Fetching BTC history from CoinGecko...');
    const url = `https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=max`;
    const res = await fetch(url);

    if (!res.ok) {
        throw new Error(`Failed to fetch history: ${res.statusText}`);
    }

    const data = await res.json();
    if (!data?.prices) {
        throw new Error('Invalid history format');
    }

    const prices = data.prices; // Array of [timestamp, price]
    console.log(`Fetched ${prices.length} price points.`);

    const existingCount = await prisma.cryptoPrice.count({
        where: { coinId: 'bitcoin' }
    });
    console.log(`Existing DB points: ${existingCount}`);

    // Get the latest timestamp in DB to avoid dupes
    const latest = await prisma.cryptoPrice.findFirst({
        where: { coinId: 'bitcoin' },
        orderBy: { timestamp: 'desc' }
    });

    const latestTs = latest ? latest.timestamp.getTime() : 0;

    const toInsert = prices
        .filter((pt: [number, number]) => pt[0] > latestTs)
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
