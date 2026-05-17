/**
 * PB-ext-4: backfill JobPosting.employmentType for rows persisted before the
 * column existed. Walks every row, runs inferEmploymentTypeFromTitle on the
 * stored title, writes the result. Idempotent — skips rows that already have
 * a value.
 *
 * Read-only by default. Pass `--fix` to write.
 *
 *   DATABASE_URL="file:./dev.db"  npx tsx scripts/tests/backfill-posting-employment-type.ts
 *   DATABASE_URL="file:./dev.db"  npx tsx scripts/tests/backfill-posting-employment-type.ts --fix
 *
 * Title-keyword inference is conservative — most postings will stay null, and
 * the UI handles null gracefully via "Include unclassified".
 */
import { prisma } from "@/lib/prisma";
import { inferEmploymentTypeFromTitle } from "@/lib/fetchers/employment-type";

async function main() {
    const fix = process.argv.includes("--fix");
    const rows = await prisma.jobPosting.findMany({
        where: { employmentType: null },
        select: { id: true, title: true },
    });

    let inferable = 0;
    const counts: Record<string, number> = {};
    const updates: Array<{ id: string; title: string; next: string }> = [];

    for (const r of rows) {
        const inferred = inferEmploymentTypeFromTitle(r.title);
        if (!inferred) continue;
        inferable++;
        counts[inferred] = (counts[inferred] ?? 0) + 1;
        updates.push({ id: r.id, title: r.title, next: inferred });
    }

    console.log(`Postings without employmentType:  ${rows.length}`);
    console.log(`Inferable from title:             ${inferable}`);
    for (const [k, v] of Object.entries(counts)) {
        console.log(`  ${k.padEnd(12)} ${v}`);
    }
    if (updates.length > 0 && updates.length <= 10) {
        console.log("\nUpdates:");
        for (const u of updates) console.log(`  "${u.title.slice(0, 60)}" → ${u.next}`);
    } else if (updates.length > 10) {
        console.log("\nFirst 10 updates:");
        for (const u of updates.slice(0, 10)) console.log(`  "${u.title.slice(0, 60)}" → ${u.next}`);
        console.log(`  …and ${updates.length - 10} more`);
    }

    if (!fix) {
        console.log("\n(Dry run — pass --fix to apply.)");
        await prisma.$disconnect();
        return;
    }
    for (const u of updates) {
        await prisma.jobPosting.update({ where: { id: u.id }, data: { employmentType: u.next } });
    }
    console.log(`\nUpdated ${updates.length} row(s).`);
    await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
