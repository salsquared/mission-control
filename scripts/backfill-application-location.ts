// One-shot backfill for Application.location (2026-06-01).
//
// Application.location was added 2026-06-01 (migration add_application_location)
// and is populated going forward at track-as-application time from
// JobPosting.location. This script fills in the EXISTING rows that pre-date the
// column by pulling the location off their linked posting.
//
// Two deterministic sources, in order of precision:
//   1. Application.postingId → JobPosting.location  (the normal linkage).
//   2. Application.sourceJobId → a JobPosting with the same externalId owned by
//      the user (covers rows whose original posting was later removed, so
//      postingId got SetNull but the ATS-stable sourceJobId survived; the same
//      job re-fetched into another watchlist still carries the location).
//
// Gmail-ingested / manual rows with NO posting linkage have no deterministic
// location source — they are left null (the sidebar lets the user set them by
// hand; auto-extraction from the email body is a separate LLM enhancement).
//
// Run with (dry-run prints the plan, no writes):
//   DATABASE_URL="file:./dev.db"  npx tsx scripts/backfill-application-location.ts
//   DATABASE_URL="file:./prod.db" npx tsx scripts/backfill-application-location.ts
// Add --write to actually apply. (Note the prisma-relative path quirk from CLAUDE.md.)
//
// Safe + idempotent: only touches rows whose location is currently null/empty,
// and only when a non-empty posting location is found. location carries no
// unique/normalization role, so there are no P2002 conflicts to handle.

import { prisma } from "@/lib/prisma";

const WRITE = process.argv.includes("--write");

function clean(loc: string | null | undefined): string | null {
    const t = (loc ?? "").trim();
    return t.length > 0 ? t : null;
}

async function main() {
    const plan: { id: string; company: string; location: string; via: "posting" | "sourceJobId" }[] = [];

    // ─── Source 1: linked posting ───────────────────────────────────────────
    const linked = await prisma.application.findMany({
        where: {
            OR: [{ location: null }, { location: "" }],
            NOT: { postingId: null },
        },
        select: {
            id: true,
            company: true,
            posting: { select: { location: true } },
        },
    });
    for (const a of linked) {
        const loc = clean(a.posting?.location);
        if (loc) plan.push({ id: a.id, company: a.company, location: loc, via: "posting" });
    }
    const linkedNoLoc = linked.length - plan.length;

    // ─── Source 2: sourceJobId orphans (posting row gone, externalId survives) ─
    const orphans = await prisma.application.findMany({
        where: {
            OR: [{ location: null }, { location: "" }],
            postingId: null,
            NOT: { sourceJobId: null },
        },
        select: { id: true, userId: true, company: true, sourceJobId: true },
    });
    let orphanResolved = 0;
    for (const a of orphans) {
        if (!a.sourceJobId) continue;
        const match = await prisma.jobPosting.findFirst({
            where: {
                externalId: a.sourceJobId,
                watchlist: { userId: a.userId },
                NOT: [{ location: null }, { location: "" }],
            },
            select: { location: true },
            orderBy: { lastSeenAt: "desc" },
        });
        const loc = clean(match?.location);
        if (loc) {
            plan.push({ id: a.id, company: a.company, location: loc, via: "sourceJobId" });
            orphanResolved++;
        }
    }

    // ─── Report ──────────────────────────────────────────────────────────────
    const totalNoLoc = await prisma.application.count({
        where: { OR: [{ location: null }, { location: "" }] },
    });
    console.log(`${WRITE ? "[WRITE]" : "[DRY-RUN]"} backfill Application.location`);
    console.log(`  rows still missing location: ${totalNoLoc}`);
    console.log(`  resolvable via linked posting: ${plan.filter(p => p.via === "posting").length} (of ${linked.length} linked-but-empty; ${linkedNoLoc} had a posting with no location)`);
    console.log(`  resolvable via sourceJobId orphan: ${orphanResolved} (of ${orphans.length} orphans checked)`);
    console.log(`  → will set: ${plan.length}; will remain null: ${totalNoLoc - plan.length}\n`);

    for (const p of plan) {
        console.log(`  ${p.id}  ${JSON.stringify(p.company)}  →  ${JSON.stringify(p.location)}  [${p.via}]`);
    }

    if (!WRITE) {
        console.log(`\nDry-run only. Re-run with --write to apply.`);
        return;
    }

    let updated = 0;
    for (const p of plan) {
        await prisma.application.update({ where: { id: p.id }, data: { location: p.location } });
        updated++;
    }
    console.log(`\nDone. updated=${updated}; rows still without location=${totalNoLoc - updated}`);
}

main()
    .catch((e) => { console.error(e); process.exit(1); })
    .finally(() => prisma.$disconnect());
