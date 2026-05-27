// One-shot backfill for Application.normalizedRole + Application.sourceJobId
// (2026-05-27 multi-role-per-company phase 1).
//
// Required before applying the phase-2 migration that swaps the unique key
// from `(userId, normalizedCompany, track)` to
// `(userId, normalizedCompany, normalizedRole, track)`. The CREATE UNIQUE
// INDEX would otherwise fail on any pre-existing row group that shares the
// new quadruple. This script populates both columns, then groups the resulting
// state and reports collisions for the operator to resolve.
//
// Run with:
//   DATABASE_URL="file:./dev.db"  npx tsx scripts/backfill-normalized-role.ts
//   DATABASE_URL="file:./prod.db" npx tsx scripts/backfill-normalized-role.ts
// (Note the prisma-relative path quirk from CLAUDE.md.)
//
// Safe to re-run; rows with non-null normalizedRole are left alone unless
// --force is passed. Same for sourceJobId.

import { prisma } from "@/lib/prisma";
import { normalizeRoleName } from "@/lib/applications/normalize-role";

const force = process.argv.includes("--force");

type Row = {
    id: string;
    userId: string;
    company: string;
    normalizedCompany: string | null;
    role: string | null;
    normalizedRole: string | null;
    track: string;
    postingId: string | null;
    sourceJobId: string | null;
};

async function main() {
    const all = await prisma.application.findMany({
        select: {
            id: true,
            userId: true,
            company: true,
            normalizedCompany: true,
            role: true,
            normalizedRole: true,
            track: true,
            postingId: true,
            sourceJobId: true,
        },
    });

    console.log(`Scanning ${all.length} Application rows.`);

    let roleUpdated = 0;
    let roleSkippedEmpty = 0;
    let sourceUpdated = 0;
    let sourceMissing = 0;
    let sourceUnchanged = 0;

    for (const row of all as Row[]) {
        // normalizedRole
        const needsRole = force || row.normalizedRole == null || row.normalizedRole === "";
        if (needsRole) {
            const key = normalizeRoleName(row.role ?? "");
            if (!key) {
                console.warn(`[role:skip-empty] id=${row.id} role=${JSON.stringify(row.role)} normalizes to empty — leaving null`);
                roleSkippedEmpty++;
            } else {
                await prisma.application.update({
                    where: { id: row.id },
                    data: { normalizedRole: key },
                });
                roleUpdated++;
            }
        }

        // sourceJobId
        if (row.postingId) {
            const needsSource = force || row.sourceJobId == null || row.sourceJobId === "";
            if (needsSource) {
                const posting = await prisma.jobPosting.findUnique({
                    where: { id: row.postingId },
                    select: { externalId: true },
                });
                if (posting?.externalId) {
                    await prisma.application.update({
                        where: { id: row.id },
                        data: { sourceJobId: posting.externalId },
                    });
                    sourceUpdated++;
                } else {
                    sourceMissing++;
                }
            } else {
                sourceUnchanged++;
            }
        }
    }

    console.log(`\n--- backfill summary ---`);
    console.log(`normalizedRole: ${roleUpdated} updated, ${roleSkippedEmpty} skipped (empty after normalize)`);
    console.log(`sourceJobId:    ${sourceUpdated} updated, ${sourceMissing} posting linkage missing externalId, ${sourceUnchanged} already populated`);

    // Collision audit against the future unique key.
    console.log(`\n--- collision audit (future @@unique([userId, normalizedCompany, normalizedRole, track])) ---`);
    const refetched = await prisma.application.findMany({
        select: { id: true, userId: true, company: true, normalizedCompany: true, role: true, normalizedRole: true, track: true, lastUpdateAt: true },
    });
    const groups = new Map<string, typeof refetched>();
    for (const r of refetched) {
        // Match SQLite's NULL-distinct semantics in unique compounds: any null
        // component → the row is excluded from the unique check entirely.
        if (r.normalizedCompany == null || r.normalizedRole == null) continue;
        const key = `${r.userId}|${r.normalizedCompany}|${r.normalizedRole}|${r.track}`;
        const list = groups.get(key) ?? [];
        list.push(r);
        groups.set(key, list);
    }
    const conflicts = [...groups.entries()].filter(([, rows]) => rows.length > 1);
    if (conflicts.length === 0) {
        console.log(`✓ no collisions — safe to apply phase-2 migration (CREATE UNIQUE INDEX) next`);
    } else {
        console.log(`✗ ${conflicts.length} colliding group(s) — RESOLVE BEFORE applying phase-2 migration:`);
        for (const [key, rows] of conflicts) {
            const [u, c, r, t] = key.split("|");
            console.log(`\n  group: user=${u} company=${JSON.stringify(c)} role=${JSON.stringify(r)} track=${t}`);
            for (const row of rows) {
                console.log(`    - id=${row.id}  raw.company=${JSON.stringify(row.company)}  raw.role=${JSON.stringify(row.role)}  lastUpdateAt=${row.lastUpdateAt.toISOString()}`);
            }
        }
    }
}

main()
    .then(() => process.exit(0))
    .catch(err => {
        console.error(err);
        process.exit(1);
    });
