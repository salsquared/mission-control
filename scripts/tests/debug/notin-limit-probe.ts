/**
 * Probe Prisma's effective parameter limit for SQLite `notIn` queries.
 * Job-watcher's close-detection uses notIn on every seenExternalId — if the
 * limit is below the biggest watchlist's posting count (SpaceX = 1688 active),
 * the close-detection silently throws and postings never get marked closed.
 */
import { prisma } from "@/lib/prisma";

async function probe(n: number) {
    const fake = Array.from({ length: n }, (_, i) => `fakeid${i}`);
    try {
        const start = Date.now();
        const result = await prisma.jobPosting.findMany({
            where: {
                watchlistId: "nonexistent-wl",
                status: { notIn: ["closed", "hidden"] },
                externalId: { notIn: fake },
                lastSeenAt: { lt: new Date(0) },
            },
            take: 1,
        });
        const ms = Date.now() - start;
        console.log(`n=${n.toString().padStart(5)}: OK (${ms}ms, ${result.length} rows)`);
        return true;
    } catch (e) {
        const msg = e instanceof Error ? e.message.slice(0, 200) : String(e);
        console.log(`n=${n.toString().padStart(5)}: ${msg}`);
        return false;
    }
}

async function main() {
    for (const n of [100, 500, 999, 1000, 1500, 2000, 3000, 5000]) {
        await probe(n);
    }
    await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
