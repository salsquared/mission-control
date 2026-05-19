/**
 * PB-14 one-shot migration: walk every Watchlist row and, where its persisted
 * `config` matches a COMPANY_DIRECTORY entry by identity key, set
 * `directoryKey` to the entry's `name`. Read-only by default; pass `--fix`.
 *
 *   DATABASE_URL="file:./dev.db"  npx tsx scripts/tests/backfill-watchlist-directory-key.ts
 *   DATABASE_URL="file:./dev.db"  npx tsx scripts/tests/backfill-watchlist-directory-key.ts --fix
 *
 * Run once per environment (dev + prod) after the schema migration lands.
 * Idempotent — running again is a no-op for rows already keyed.
 */
import { prisma } from "@/lib/prisma";
import { COMPANY_DIRECTORY, watchlistConfigKey } from "@/lib/company-directory";

async function main() {
    const fix = process.argv.includes("--fix");

    // Pre-index the directory by identity key so the per-row lookup is O(1).
    const byKey = new Map<string, string>(); // key → entry.name
    for (const e of COMPANY_DIRECTORY) {
        const k = watchlistConfigKey(e.config);
        if (k) byKey.set(k, e.name);
    }

    const rows = await prisma.watchlist.findMany({
        select: { id: true, name: true, config: true, kind: true, directoryKey: true },
    });

    let matched = 0;
    let already = 0;
    let skipped = 0;
    let updates: Array<{ id: string; name: string; directoryKey: string }> = [];
    let unmatched: Array<{ id: string; name: string; kind: string }> = [];

    for (const r of rows) {
        if (r.directoryKey) { already++; continue; }
        let cfg: unknown;
        try { cfg = JSON.parse(r.config); }
        catch { skipped++; continue; }

        // The configKey helper expects a typed WatchlistConfig — it works on
        // anything with the right kind+slug/host fields, so plain JSON is OK.
        const key = watchlistConfigKey(cfg as Parameters<typeof watchlistConfigKey>[0]);
        if (!key) { unmatched.push({ id: r.id, name: r.name, kind: r.kind }); continue; }
        const entryName = byKey.get(key);
        if (!entryName) { unmatched.push({ id: r.id, name: r.name, kind: r.kind }); continue; }

        matched++;
        updates.push({ id: r.id, name: r.name, directoryKey: entryName });
    }

    console.log(`Total watchlists:           ${rows.length}`);
    console.log(`Already keyed:              ${already}`);
    console.log(`Skipped (unparseable):      ${skipped}`);
    console.log(`Unmatched (no directory):   ${unmatched.length}`);
    console.log(`Matchable to directory:     ${matched}`);
    console.log("");

    if (updates.length > 0) {
        console.log("Matched rows:");
        for (const u of updates) {
            console.log(`  ${u.id}  "${u.name}"  → directoryKey="${u.directoryKey}"`);
        }
        console.log("");
    }
    if (unmatched.length > 0) {
        console.log("Unmatched rows (will keep using stored config snapshot — no change):");
        for (const u of unmatched) {
            console.log(`  ${u.id}  "${u.name}"  kind=${u.kind}`);
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
            data: { directoryKey: u.directoryKey },
        });
    }
    console.log(`Updated ${updates.length} row(s).`);
    await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
