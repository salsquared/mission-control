// One-shot migration: rewrite stored keyword strings from the legacy boolean
// form (`"AI trainer" OR "data annotator"`) to the plain comma-list form the
// user now types and sees (`AI trainer, data annotator`).
//
// The boolean OR / quoting LinkedIn/Indeed need is added at fetch time only
// (lib/watchlists/keyword-query.ts), so this is purely cosmetic — un-migrated
// rows still work (buildSearchQuery is idempotent on legacy strings). We
// migrate so existing Watchlist (linkedin/indeed) + Canon rows stop SHOWING
// OR/quotes in the UI.
//
// Reuses splitCanonKeywords as the canonical tokenizer (strips quotes/parens,
// splits on OR/comma/semicolon/newline, dedupes), then rejoins with ", ".
// Idempotent: a row already in comma form is left unchanged.
//
// Dry-run by default (prints before → after). Pass --write to commit.
//   DATABASE_URL="file:./dev.db"  npx tsx scripts/migrate-keywords-to-comma.ts [--write]
//   DATABASE_URL="file:./prod.db" npx tsx scripts/migrate-keywords-to-comma.ts [--write]
// (Note the prisma-relative path quirk from CLAUDE.md — dev.db, not prisma/dev.db.)

import { prisma } from "@/lib/prisma";
import { splitCanonKeywords } from "@/lib/canons/keywords";

const write = process.argv.includes("--write");

function toCommaList(raw: string): string {
    return splitCanonKeywords(raw).join(", ");
}

async function migrateWatchlists() {
    const rows = await prisma.watchlist.findMany({
        where: { kind: { in: ["linkedin", "indeed"] } },
        select: { id: true, name: true, config: true },
    });
    let changed = 0;
    let skippedEmpty = 0;
    for (const row of rows) {
        let cfg: { keywords?: unknown };
        try {
            cfg = JSON.parse(row.config) as { keywords?: unknown };
        } catch {
            console.warn(`[watchlist:bad-json] id=${row.id} name=${JSON.stringify(row.name)} — skipping`);
            continue;
        }
        if (typeof cfg.keywords !== "string") continue;
        const before = cfg.keywords;
        const after = toCommaList(before);
        if (after === before) continue;
        if (!after) {
            // keywords is NOT NULL min(1) on the schema — never write empty.
            console.warn(`[watchlist:empty-after] id=${row.id} name=${JSON.stringify(row.name)} before=${JSON.stringify(before)} → empty, leaving as-is`);
            skippedEmpty++;
            continue;
        }
        console.log(`[watchlist] id=${row.id} ${JSON.stringify(before)}\n          → ${JSON.stringify(after)}`);
        if (write) {
            await prisma.watchlist.update({
                where: { id: row.id },
                data: { config: JSON.stringify({ ...(cfg as object), keywords: after }) },
            });
        }
        changed++;
    }
    console.log(`\nWatchlists: ${changed} ${write ? "updated" : "would change"}${skippedEmpty ? `, ${skippedEmpty} skipped (empty after normalize)` : ""} (of ${rows.length} linkedin/indeed rows).`);
}

async function migrateCanons() {
    const rows = await prisma.canon.findMany({ select: { id: true, name: true, keywords: true } });
    let changed = 0;
    for (const row of rows) {
        const before = row.keywords ?? "";
        const after = toCommaList(before);
        if (after === before) continue;
        console.log(`[canon] id=${row.id} name=${JSON.stringify(row.name)} ${JSON.stringify(before)}\n      → ${JSON.stringify(after)}`);
        if (write) {
            await prisma.canon.update({ where: { id: row.id }, data: { keywords: after } });
        }
        changed++;
    }
    console.log(`\nCanons: ${changed} ${write ? "updated" : "would change"} (of ${rows.length} rows).`);
}

async function main() {
    console.log(`=== keyword → comma-list migration (${write ? "WRITE" : "DRY-RUN"}) ===\n`);
    await migrateWatchlists();
    console.log("");
    await migrateCanons();
    if (!write) console.log(`\n(dry-run — re-run with --write to commit)`);
}

main()
    .then(() => process.exit(0))
    .catch(err => { console.error(err); process.exit(1); });
