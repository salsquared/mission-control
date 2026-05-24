/**
 * Has the close-detection actually been failing for SpaceX/Boeing? Symptom:
 * stale active rows (lastSeenAt much older than runAt) that should have been
 * closed but weren't. Compare last successful watchlist run vs oldest stale
 * row in that watchlist.
 */
import { prisma } from "@/lib/prisma";

async function main() {
    const watchlistIds = [
        { name: "SpaceX",       id: "mig8df52f3" },
        { name: "Boeing",       id: "cmpeekh7m0" },
        { name: "Blue Origin",  id: "cmpeekh760" },
        { name: "Anthropic",    id: "cmpeekh7r0" },  // 392 active — under 999 limit, control
    ];
    for (const { name, id } of watchlistIds) {
        const wl = await prisma.watchlist.findUnique({
            where: { id },
            select: { lastRunAt: true, lastSuccessAt: true, lastError: true },
        });
        const activeCount = await prisma.jobPosting.count({
            where: { watchlistId: id, status: { notIn: ["closed", "hidden"] } },
        });
        const oldestStale = await prisma.jobPosting.findFirst({
            where: { watchlistId: id, status: { notIn: ["closed", "hidden"] } },
            orderBy: { lastSeenAt: "asc" },
            select: { lastSeenAt: true, title: true, company: true },
        });
        const staleAgo = oldestStale && wl?.lastRunAt
            ? Math.round((wl.lastRunAt.getTime() - oldestStale.lastSeenAt.getTime()) / 3_600_000)
            : null;
        console.log(`\n${name} (${id.slice(0,10)}):`);
        console.log(`  active: ${activeCount}  exceeds-999?: ${activeCount > 999}`);
        console.log(`  lastRunAt: ${wl?.lastRunAt?.toISOString() ?? '?'}`);
        console.log(`  lastSuccessAt: ${wl?.lastSuccessAt?.toISOString() ?? '?'}`);
        console.log(`  lastError: ${wl?.lastError ?? '(none)'}`);
        if (oldestStale) {
            console.log(`  oldest active row lastSeenAt: ${oldestStale.lastSeenAt.toISOString()} (${staleAgo}h before lastRunAt)`);
            console.log(`    "${oldestStale.company} | ${oldestStale.title}"`);
        }
    }
    await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
