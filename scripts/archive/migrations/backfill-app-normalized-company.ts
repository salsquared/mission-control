/**
 * PA-3 one-shot migration: walk every Application row and populate the new
 * `normalizedCompany` column from `normalizeCompanyName(company)`. Idempotent —
 * skips rows that already have a value.
 *
 * Read-only by default. Pass `--fix` to write.
 *
 *   DATABASE_URL="file:./dev.db"  npx tsx scripts/tests/backfill-app-normalized-company.ts
 *   DATABASE_URL="file:./dev.db"  npx tsx scripts/tests/backfill-app-normalized-company.ts --fix
 *
 * Run once per environment after the schema migration lands.
 */
import { prisma } from "@/lib/prisma";
import { normalizeCompanyName } from "@/lib/applications/normalize-company";

interface Row {
    id: string;
    userId: string;
    company: string;
    normalizedCompany: string | null;
}

async function main() {
    const fix = process.argv.includes("--fix");
    const rows = await prisma.application.findMany({
        select: { id: true, userId: true, company: true, normalizedCompany: true },
    });

    let already = 0;
    let toUpdate: Array<{ id: string; company: string; current: string | null; next: string }> = [];
    let collisions: Array<{ a: Row; b: Row; key: string }> = [];

    // Group by (userId, normalizedKey) so we surface collisions BEFORE writing —
    // legacy rows with duplicates for the same employer would otherwise crash
    // the backfill at the @@unique constraint.
    const byKey = new Map<string, Row[]>();
    for (const r of rows) {
        if (r.normalizedCompany) { already++; continue; }
        const next = normalizeCompanyName(r.company);
        if (!next) continue;
        const k = `${r.userId}::${next}`;
        const bucket = byKey.get(k) ?? [];
        bucket.push(r);
        byKey.set(k, bucket);
        toUpdate.push({ id: r.id, company: r.company, current: r.normalizedCompany, next });
    }

    for (const [key, bucket] of byKey.entries()) {
        if (bucket.length > 1) {
            // First one wins; others stay unkeyed. Surface so the user can decide.
            for (let i = 1; i < bucket.length; i++) {
                collisions.push({ a: bucket[0], b: bucket[i], key: key.split("::")[1] });
            }
            // Strip the colliding row(s) from the update list.
            toUpdate = toUpdate.filter(u => !bucket.slice(1).some(b => b.id === u.id));
        }
    }

    console.log(`Total Application rows:    ${rows.length}`);
    console.log(`Already keyed:             ${already}`);
    console.log(`Will set normalizedCompany:${toUpdate.length}`);
    console.log(`Collisions (skipped):      ${collisions.length}`);

    if (collisions.length > 0) {
        console.log("\nCollisions — these rows DUPLICATE an existing employer per the normalizer.");
        console.log("They stay with normalizedCompany=NULL. Merge or delete manually if you want them keyed.");
        for (const c of collisions) {
            console.log(`  user=${c.a.userId.slice(0,8)} key="${c.key}"`);
            console.log(`    [keeping]  ${c.a.id}  "${c.a.company}"`);
            console.log(`    [skipped]  ${c.b.id}  "${c.b.company}"`);
        }
    }

    if (toUpdate.length > 0) {
        console.log("\nRows to update (first 10 shown):");
        for (const u of toUpdate.slice(0, 10)) {
            console.log(`  ${u.id}  "${u.company}"  →  "${u.next}"`);
        }
        if (toUpdate.length > 10) console.log(`  …and ${toUpdate.length - 10} more`);
    }

    if (!fix) {
        console.log("\n(Dry run — pass --fix to apply.)");
        await prisma.$disconnect();
        return;
    }
    for (const u of toUpdate) {
        await prisma.application.update({
            where: { id: u.id },
            data: { normalizedCompany: u.next },
        });
    }
    console.log(`\nUpdated ${toUpdate.length} row(s).`);
    await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
