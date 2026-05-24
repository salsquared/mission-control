/**
 * How many active job postings have null compensation but their current
 * snippet/title/location now PARSES into a non-null comp via the same
 * parseCompensation the create branch uses? Those rows are stale —
 * compensationMin/Max/etc. weren't backfilled when the source added pay
 * transparency later.
 */
import { prisma } from "@/lib/prisma";
import { parseCompensation } from "@/lib/postings/compensation";

async function main() {
    const candidates = await prisma.jobPosting.findMany({
        where: {
            status: { notIn: ["closed", "hidden"] },
            compensationMin: null,
            compensationMax: null,
        },
        select: { id: true, title: true, snippet: true, location: true },
        take: 50_000,
    });
    let parsed = 0;
    const samples: string[] = [];
    for (const c of candidates) {
        const hay = [c.title, c.snippet, c.location].filter(Boolean).join("\n");
        const comp = parseCompensation(hay);
        if (comp && (comp.min != null || comp.max != null)) {
            parsed++;
            if (samples.length < 5) samples.push(`  ${c.title} | min=${comp.min} max=${comp.max} ${comp.currency}/${comp.cadence}`);
        }
    }
    console.log(`Active null-comp rows scanned: ${candidates.length}`);
    console.log(`Would now parse a non-null comp: ${parsed}`);
    console.log("\nSamples:");
    samples.forEach(s => console.log(s));
    await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
