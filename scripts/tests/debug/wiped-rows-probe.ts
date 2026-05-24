/**
 * Count JobPosting rows that have null employmentType but could be self-
 * healed by cross-watchlist lookup (i.e. another watchlist has the same
 * externalId with a non-null classification). These rows will get fixed
 * on the next crawl after the Bug A+B fix lands.
 */
import { prisma } from "@/lib/prisma";

async function main() {
    const nullRows = await prisma.jobPosting.findMany({
        where: { employmentType: null },
        select: { id: true, externalId: true, watchlistId: true, company: true, title: true },
    });
    console.log(`Total rows with null employmentType: ${nullRows.length}`);

    if (nullRows.length === 0) {
        await prisma.$disconnect();
        return;
    }

    const externalIds = [...new Set(nullRows.map(r => r.externalId))];
    // SQLite parameter limit — chunk the in() clause. The production path uses
    // smaller per-crawl batches and won't hit this; this probe scans the whole DB.
    const CHUNK = 500;
    const classifiedMap = new Map<string, string>();
    for (let i = 0; i < externalIds.length; i += CHUNK) {
        const slice = externalIds.slice(i, i + CHUNK);
        const classified = await prisma.jobPosting.findMany({
            where: { externalId: { in: slice }, employmentType: { not: null } },
            select: { externalId: true, employmentType: true },
            distinct: ["externalId"],
        });
        for (const r of classified) if (r.employmentType) classifiedMap.set(r.externalId, r.employmentType);
    }

    const healable = nullRows.filter(r => classifiedMap.has(r.externalId));
    const orphans = nullRows.filter(r => !classifiedMap.has(r.externalId));

    console.log(`  → ${healable.length} self-healable (another watchlist has classified)`);
    console.log(`  → ${orphans.length} orphaned (no other watchlist has this externalId classified)`);

    if (healable.length > 0) {
        console.log(`\nSample healable rows (first 5):`);
        for (const r of healable.slice(0, 5)) {
            console.log(`  ${r.watchlistId.slice(0, 8)} ${r.company} | ${r.title} → ${classifiedMap.get(r.externalId)}`);
        }
    }

    await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
