/**
 * Diagnose the "LLM reclassifying same jobs" bug. For each posting in the
 * shared 8-row batch, show: does it exist in the DB, how many copies, what
 * employmentType is stored, when first/last seen, and whether the
 * externalId looks stable across hypothetical re-runs.
 */
import { prisma } from "@/lib/prisma";
import { createHash } from "node:crypto";

function externalIdFor(company: string, title: string, sourceUrl: string): string {
    return createHash("sha256").update(`${company}|${title}|${sourceUrl}`).digest("hex");
}

const TITLES = [
    "Multi-Site Security Officers",
    "Campus Safety Officer",
    "Executive Protection Agent",
    "Senior Analyst, Security - El Segundo, CA",
    "Personnel Security (PERSEC) Lead",
    "Sr. Information System Security Officer (ISSO)",
    "Asset Protection Specialist - Second Shift/Afternoon Start",
    "Security Project Specialist 2",
];

async function main() {
    for (const title of TITLES) {
        const rows = await prisma.jobPosting.findMany({
            where: { title },
            select: { id: true, watchlistId: true, externalId: true, company: true, title: true, sourceUrl: true, employmentType: true, firstSeenAt: true, lastSeenAt: true },
            orderBy: { firstSeenAt: "asc" },
        });
        console.log(`\n=== "${title}" — ${rows.length} row(s) ===`);
        for (const r of rows) {
            const recomputed = externalIdFor(r.company, r.title, r.sourceUrl);
            const hashStable = recomputed === r.externalId;
            console.log(`  wl=${r.watchlistId.slice(0, 8)} id=${r.externalId.slice(0, 12)} type=${r.employmentType ?? "null"} firstSeen=${r.firstSeenAt.toISOString().slice(0, 19)} lastSeen=${r.lastSeenAt.toISOString().slice(0, 19)} hashStable=${hashStable}`);
            if (!hashStable) {
                console.log(`    stored externalId: ${r.externalId}`);
                console.log(`    recomputed:       ${recomputed}`);
                console.log(`    company: ${JSON.stringify(r.company)}`);
                console.log(`    title:   ${JSON.stringify(r.title)}`);
                console.log(`    url:     ${JSON.stringify(r.sourceUrl)}`);
            }
        }
    }
    await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
