/**
 * Are users getting multiple notifications for the same job posting just
 * because it appears in multiple watchlists?
 *
 * job-watcher dispatches with `dedupKey: posting:${created.id}` — posting.id
 * is unique per row, so same `externalId` in two watchlists = two posting
 * rows = two distinct dedup keys = two notifications.
 */
import { prisma } from "@/lib/prisma";

async function main() {
    // Find externalIds that appear in >1 watchlist (cross-watchlist overlap).
    const grouped = await prisma.jobPosting.groupBy({
        by: ["externalId"],
        _count: { id: true },
        having: { id: { _count: { gt: 1 } } },
        orderBy: { _count: { id: "desc" } },
        take: 10,
    });
    console.log(`Distinct externalIds appearing in >1 watchlist: ${grouped.length} (top 10 shown)`);
    for (const g of grouped) {
        const rows = await prisma.jobPosting.findMany({
            where: { externalId: g.externalId },
            select: { id: true, watchlistId: true, company: true, title: true },
        });
        const wlIds = rows.map(r => r.watchlistId.slice(0,8)).join(",");
        console.log(`  ${g._count.id} copies — ${rows[0].company} | ${rows[0].title} — watchlists [${wlIds}]`);
        const notifs = await prisma.notification.findMany({
            where: { dedupKey: { in: rows.map(r => `posting:${r.id}`) } },
            select: { id: true, createdAt: true, dedupKey: true },
        });
        if (notifs.length > 1) {
            console.log(`    → ${notifs.length} notifications fired (one per copy):`);
            for (const n of notifs) console.log(`        ${n.createdAt.toISOString()} ${n.dedupKey}`);
        } else if (notifs.length === 1) {
            console.log(`    → 1 notification (only one watchlist fired notify)`);
        } else {
            console.log(`    → 0 notifications (notify mode was digest/silent on both)`);
        }
    }
    await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
