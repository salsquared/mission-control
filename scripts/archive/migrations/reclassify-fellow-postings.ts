/**
 * One-shot reclassification: JobPosting rows currently tagged
 * `employmentType: 'internship'` whose title contains "fellow" or
 * "fellowship" → set to `full-time`. Decision recorded in
 * `lib/fetchers/employment-type.ts` (token map) on 2026-05-19; this script
 * back-fills rows that were classified under the old policy.
 *
 * Read-only by default; pass `--fix` to apply.
 *
 *   DATABASE_URL="file:./dev.db"   npx tsx scripts/archive/migrations/reclassify-fellow-postings.ts
 *   DATABASE_URL="file:./dev.db"   npx tsx scripts/archive/migrations/reclassify-fellow-postings.ts --fix
 *   DATABASE_URL="file:./prod.db"  npx tsx scripts/archive/migrations/reclassify-fellow-postings.ts --fix
 *
 * Idempotent — once a row is full-time the WHERE filter no longer matches it.
 *
 * Carve-out: rows whose title ALSO matches the "Summer 2026 / Fall 2026 ..."
 * season+year pattern are left as internship. Those genuinely are summer-
 * cohort student fellowships and the Tier-A heuristic would re-classify them
 * the same way at ingest.
 */
import { prisma } from "@/lib/prisma";

const SEASON_YEAR_RE = /\b(spring|summer|fall|autumn|winter)\s+20\d{2}\b/i;

async function main() {
    const fix = process.argv.includes("--fix");

    // SQLite LIKE is ASCII-case-insensitive by default, so this catches
    // "Fellow", "fellow", "Fellowship", "FELLOWS", etc.
    const rows = await prisma.jobPosting.findMany({
        where: {
            employmentType: "internship",
            OR: [
                { title: { contains: "fellow" } },
                { title: { contains: "Fellow" } },
            ],
        },
        select: { id: true, company: true, title: true },
    });

    const reclassify: typeof rows = [];
    const keepAsInternship: typeof rows = [];
    for (const r of rows) {
        if (SEASON_YEAR_RE.test(r.title)) keepAsInternship.push(r);
        else reclassify.push(r);
    }

    console.log(`Total internship rows matching fellow*: ${rows.length}`);
    console.log(`  Reclassify → full-time:               ${reclassify.length}`);
    console.log(`  Keep as internship (summer cohort):   ${keepAsInternship.length}`);
    console.log("");

    if (reclassify.length > 0) {
        console.log("Reclassify plan:");
        for (const r of reclassify) {
            console.log(`  ${r.id}  ${r.company} — ${r.title}`);
        }
        console.log("");
    }
    if (keepAsInternship.length > 0) {
        console.log("Left as internship (season+year guard):");
        for (const r of keepAsInternship) {
            console.log(`  ${r.id}  ${r.company} — ${r.title}`);
        }
        console.log("");
    }

    if (!fix) {
        console.log("(Dry run — pass --fix to apply.)");
        await prisma.$disconnect();
        return;
    }
    for (const r of reclassify) {
        await prisma.jobPosting.update({
            where: { id: r.id },
            data: { employmentType: "full-time" },
        });
    }
    console.log(`Updated ${reclassify.length} row(s).`);
    await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
