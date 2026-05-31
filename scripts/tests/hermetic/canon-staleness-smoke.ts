// Hermetic smoke for entity-scoped canon staleness (docs/canonical-resumes.html
// §6 Q7 / §7 P3.3 / P3.4). A canon goes stale ONLY when an entity in its
// current resume's dependency set (resumeEntityIds) changes; unrelated entities
// and sibling canons are untouched. Runs against dev.db with self-cleanup.
//   npx tsx scripts/tests/hermetic/canon-staleness-smoke.ts

import { prisma } from "@/lib/prisma";
import {
    createCanon,
    getCanon,
    finalizeCanonGeneration,
    markCanonsStaleForEntity,
} from "@/lib/repositories/canons";

let passes = 0;
let fails = 0;
function ok(msg: string, cond: boolean) {
    if (cond) { console.log(`[PASS] ${msg}`); passes++; }
    else { console.error(`[FAIL] ${msg}`); fails++; }
}

async function main() {
    const user = await prisma.user.findFirst({ select: { id: true } });
    if (!user) { console.error("No user in dev.db — log in once first."); process.exit(1); }
    const userId = user.id;
    const stamp = Date.now();
    const ids: string[] = [];

    try {
        // Two canons, both "fresh" with distinct dependency sets.
        const a = await createCanon(userId, { name: `Stale A ${stamp}`, track: "career", keywords: "" });
        const b = await createCanon(userId, { name: `Stale B ${stamp}`, track: "side", keywords: "" });
        ids.push(a.id, b.id);
        await finalizeCanonGeneration(a.id, "res-a", ["entA1", "entA2"]);
        await finalizeCanonGeneration(b.id, "res-b", ["entB1"]);
        ok("setup: A fresh", (await getCanon(userId, a.id))?.resumeStale === false);
        ok("setup: B fresh", (await getCanon(userId, b.id))?.resumeStale === false);

        // Edit an entity in A's set → only A stales.
        const n1 = await markCanonsStaleForEntity(userId, "entA1");
        ok("entity in A → exactly 1 canon staled", n1 === 1);
        ok("A is now stale", (await getCanon(userId, a.id))?.resumeStale === true);
        ok("sibling B stays fresh", (await getCanon(userId, b.id))?.resumeStale === false);

        // Reset A; an entity in NO canon's set → nothing stales.
        await finalizeCanonGeneration(a.id, "res-a", ["entA1", "entA2"]);
        const n2 = await markCanonsStaleForEntity(userId, "entUNRELATED");
        ok("unrelated entity → 0 canons staled", n2 === 0);
        ok("A still fresh", (await getCanon(userId, a.id))?.resumeStale === false);
        ok("B still fresh", (await getCanon(userId, b.id))?.resumeStale === false);

        // An already-stale canon isn't re-counted (only fresh canons are scanned).
        await prisma.canon.update({ where: { id: a.id }, data: { resumeStale: true } });
        const n3 = await markCanonsStaleForEntity(userId, "entA2");
        ok("already-stale canon not re-counted", n3 === 0);
    } finally {
        for (const id of ids) await prisma.canon.delete({ where: { id } }).catch(() => {});
    }

    console.log(`\n${passes} passed, ${fails} failed`);
    process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
