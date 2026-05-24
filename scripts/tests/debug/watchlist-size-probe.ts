import { prisma } from "@/lib/prisma";

async function main() {
    const counts = await prisma.jobPosting.groupBy({
        by: ["watchlistId"],
        _count: { id: true },
        orderBy: { _count: { id: "desc" } },
        take: 10,
    });
    console.log("Top 10 watchlists by total posting count:");
    for (const c of counts) {
        const wl = await prisma.watchlist.findUnique({
            where: { id: c.watchlistId },
            select: { name: true, kind: true, lastRunAt: true },
        });
        console.log(`  ${c.watchlistId.slice(0,10)} ${(wl?.kind??'?').padEnd(15)} ${c._count.id.toString().padStart(5)} rows  "${wl?.name ?? '?'}"`);
    }

    // Active-only count (status not closed/hidden) — this is what the
    // updateMany `notIn: seenExternalIds` actually filters against.
    console.log("\nActive (status not in [closed,hidden]) counts — these drive the close-detection updateMany:");
    const active = await prisma.jobPosting.groupBy({
        by: ["watchlistId"],
        where: { status: { notIn: ["closed", "hidden"] } },
        _count: { id: true },
        orderBy: { _count: { id: "desc" } },
        take: 10,
    });
    for (const c of active) {
        const wl = await prisma.watchlist.findUnique({
            where: { id: c.watchlistId },
            select: { name: true },
        });
        console.log(`  ${c.watchlistId.slice(0,10)} ${c._count.id.toString().padStart(5)} active  "${wl?.name ?? '?'}"`);
    }
    await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
