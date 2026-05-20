/**
 * One-shot cleanup: strip the trailing " — jobs" suffix from Watchlist.name.
 *
 * The "Watch company" and "Discover" tabs in AddWatchlistModal used to stamp
 * `${entry.name} — jobs` onto every newly-created row. This card lives under
 * the job-discovery dash — the suffix was redundant, and led to dedup bugs
 * in NewPostingsCard's company-chip list. Modal now uses `entry.name`
 * verbatim; this script back-fills existing rows.
 *
 * Read-only by default; pass `--fix` to apply.
 *
 *   DATABASE_URL="file:./dev.db"   npx tsx scripts/archive/migrations/strip-watchlist-jobs-suffix.ts
 *   DATABASE_URL="file:./dev.db"   npx tsx scripts/archive/migrations/strip-watchlist-jobs-suffix.ts --fix
 *   DATABASE_URL="file:./prod.db"  npx tsx scripts/archive/migrations/strip-watchlist-jobs-suffix.ts --fix
 *
 * Idempotent — running again is a no-op for rows whose names no longer
 * carry the suffix.
 */
import { prisma } from "@/lib/prisma";

// Match the exact em-dash pattern the modal generated. Trailing whitespace
// tolerated; case-insensitive on "jobs" just in case anyone hand-typed it.
const JOBS_SUFFIX_RE = /\s+—\s+jobs\s*$/i;

async function main() {
    const fix = process.argv.includes("--fix");

    const rows = await prisma.watchlist.findMany({
        select: { id: true, name: true },
    });

    const updates: Array<{ id: string; oldName: string; newName: string }> = [];
    for (const r of rows) {
        if (!JOBS_SUFFIX_RE.test(r.name)) continue;
        const newName = r.name.replace(JOBS_SUFFIX_RE, "").trim();
        if (!newName) continue; // defensive — never blank the field
        updates.push({ id: r.id, oldName: r.name, newName });
    }

    console.log(`Total watchlists:    ${rows.length}`);
    console.log(`Carrying suffix:     ${updates.length}`);
    console.log("");

    if (updates.length > 0) {
        console.log("Rename plan:");
        for (const u of updates) {
            console.log(`  ${u.id}  "${u.oldName}"  →  "${u.newName}"`);
        }
        console.log("");
    }

    if (!fix) {
        console.log("(Dry run — pass --fix to apply.)");
        await prisma.$disconnect();
        return;
    }
    for (const u of updates) {
        await prisma.watchlist.update({
            where: { id: u.id },
            data: { name: u.newName },
        });
    }
    console.log(`Updated ${updates.length} row(s).`);
    await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
