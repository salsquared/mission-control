/**
 * One-off: detect + fix the stale Rocket Lab Greenhouse slug
 * (`rocketlabusa` → `rocketlab`).
 *
 * Read-only by default. Pass `--fix` to update matching rows.
 *
 *   DATABASE_URL="file:./dev.db"  npx tsx scripts/tests/probes/rocket-lab-slug-check.ts
 *   DATABASE_URL="file:./dev.db"  npx tsx scripts/tests/probes/rocket-lab-slug-check.ts --fix
 */
import { prisma } from "@/lib/prisma";

async function main() {
    const fix = process.argv.includes("--fix");
    const rows = await prisma.watchlist.findMany({
        where: { kind: "greenhouse" },
        select: { id: true, name: true, config: true, active: true },
    });
    console.log(`Found ${rows.length} greenhouse watchlist(s) in ${process.env.DATABASE_URL}`);
    let touched = 0;
    for (const r of rows) {
        const cfg = JSON.parse(r.config) as { kind: string; boardSlug?: string; companyName?: string };
        const tag = `  ${r.id}  ${r.name}  slug=${cfg.boardSlug}`;
        if (cfg.boardSlug === "rocketlabusa") {
            console.log(`${tag}  ← STALE`);
            if (fix) {
                cfg.boardSlug = "rocketlab";
                await prisma.watchlist.update({
                    where: { id: r.id },
                    data: { config: JSON.stringify(cfg), lastError: null },
                });
                touched++;
                console.log(`     → updated to boardSlug=rocketlab`);
            }
        } else {
            console.log(tag);
        }
    }
    if (fix) console.log(`\nUpdated ${touched} row(s).`);
    else if (rows.some(r => JSON.parse(r.config).boardSlug === "rocketlabusa")) {
        console.log("\nRun with --fix to update.");
    }
    await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
