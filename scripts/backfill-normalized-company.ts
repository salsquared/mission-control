// One-shot backfill for Application.normalizedCompany.
//
// Background (2026-05-27): `lib/postings/track-as-application.ts` used to call
// `tx.application.create({...})` directly with the posting's raw company,
// bypassing the `createApplication` helper that auto-normalizes. Every "Track
// this posting" promotion landed with normalizedCompany=null, which made
// Gmail ingest unable to dedup against those rows and spawn duplicate
// applications on the career track.
//
// The leak is now plugged at the source. This script fills in the existing
// damage: every Application row with null/empty normalizedCompany gets
// `normalizeCompanyName(company)` written back.
//
// Run with:
//   DATABASE_URL="file:./dev.db"  npx tsx scripts/backfill-normalized-company.ts
//   DATABASE_URL="file:./prod.db" npx tsx scripts/backfill-normalized-company.ts
// (Note the prisma-relative path quirk from CLAUDE.md.)
//
// Safe to re-run; rows that already have a non-empty normalizedCompany are
// untouched. P2002 conflicts (the backfill key collides with an existing row
// on the same track) are logged and skipped — the operator can resolve the
// duplicate manually in the kanban.

import { prisma } from "@/lib/prisma";
import { normalizeCompanyName } from "@/lib/applications/normalize-company";

async function main() {
    // normalizedCompany is NOT NULL as of 2026-06-01, but this backfill is the
    // PRE-migration prereq: it may run against a DB whose column is still
    // nullable while the generated client (this checkout's schema) types the
    // field as required. A typed findMany can no longer express
    // `normalizedCompany: null`, so select candidates with raw SQL — it works
    // on both the legacy nullable shape and the migrated one (returning nothing
    // once the column is NOT NULL and fully populated).
    const candidates = await prisma.$queryRaw<
        { id: string; userId: string; company: string; track: string }[]
    >`SELECT "id", "userId", "company", "track" FROM "Application"
      WHERE "normalizedCompany" IS NULL OR "normalizedCompany" = ''`;

    console.log(`Found ${candidates.length} rows with null/empty normalizedCompany.`);

    let updated = 0;
    let skippedEmpty = 0;
    let skippedConflict = 0;
    let errored = 0;

    for (const row of candidates) {
        const key = normalizeCompanyName(row.company);
        if (!key) {
            console.warn(`[skip-empty] id=${row.id} company=${JSON.stringify(row.company)} normalizes to empty — leaving null`);
            skippedEmpty++;
            continue;
        }
        try {
            await prisma.application.update({
                where: { id: row.id },
                data: { normalizedCompany: key },
            });
            updated++;
        } catch (err: any) {
            if (err?.code === "P2002") {
                // Collision with another row at (userId, normalizedCompany, track).
                // Look up the existing collider so the operator knows what to
                // resolve. Don't delete or merge automatically — the right
                // answer (keep which row, which timeline) depends on the case.
                const collider = await prisma.application.findFirst({
                    where: {
                        userId: row.userId,
                        normalizedCompany: key,
                        track: row.track,
                        NOT: { id: row.id },
                    },
                    select: { id: true, company: true, status: true, lastUpdateAt: true },
                });
                console.warn(
                    `[skip-conflict] id=${row.id} company=${JSON.stringify(row.company)} ` +
                    `→ key="${key}" already exists on track=${row.track} as ` +
                    `${collider ? `id=${collider.id} company=${JSON.stringify(collider.company)} status=${collider.status} updated=${collider.lastUpdateAt.toISOString()}` : "<not found?>"} ` +
                    `— resolve manually`,
                );
                skippedConflict++;
            } else {
                console.error(`[error] id=${row.id} company=${JSON.stringify(row.company)}:`, err);
                errored++;
            }
        }
    }

    console.log(
        `\nDone. updated=${updated} skipped(empty)=${skippedEmpty} ` +
        `skipped(conflict)=${skippedConflict} errored=${errored}`,
    );
}

main()
    .catch((e) => { console.error(e); process.exit(1); })
    .finally(() => prisma.$disconnect());
