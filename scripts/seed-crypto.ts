/**
 * seed-crypto.ts
 * 
 * Purpose: Quick Database Reset / Initial Seeding.
 * This script is meant to act as a database seed. It resets your database with a snapshot of recent data.
 * It fetches the last 24 hours of Bitcoin data from CoinGecko.
 * WARNING: This script deletes all existing Bitcoin data in the database before inserting the new data.
 */

import { prisma } from '../lib/prisma';

async function main() {
    console.log('Fetching historical bitcoin data from CoinGecko (last 24h)...');
    const res = await fetch('https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=1');
    const data = await res.json();

    if (!data?.prices) {
        throw new Error('Could not fetch historical prices');
    }

    console.log(`Clearing old bitcoin data...`);
    await prisma.cryptoPrice.deleteMany({ where: { coinId: 'bitcoin' } });

    console.log(`Inserting ${data.prices.length} historical price points...`);

    const entries = data.prices.map((pt: [number, number]) => ({
        coinId: 'bitcoin',
        timestamp: new Date(pt[0]),
        price: pt[1]
    }));

    await prisma.cryptoPrice.createMany({
        data: entries,
    });

    console.log('Seed completed successfully.');
}

main()
    .catch(e => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
