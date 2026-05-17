/**
 * PB-6 hermetic smoke. Exercises the WebhookDelivery table's INSERT OR IGNORE
 * semantics directly via Prisma — no HTTP, no Gmail. Verifies:
 *
 *   1. First insert of a fresh messageId succeeds.
 *   2. Second insert of the SAME messageId throws P2002 (the route's catch
 *      pattern then returns 200 + deduped=true).
 *   3. Different messageId in the same envelope batch is independent.
 *
 * Hits dev.db. Idempotent — each run uses unique timestamped messageIds and
 * cleans them up at the end.
 */
import { prisma } from "@/lib/prisma";

let passed = 0;
let failed = 0;
function check(name: string, condition: boolean, detail?: string) {
    if (condition) { console.log(`[PASS] ${name}`); passed++; }
    else { console.error(`[FAIL] ${name}${detail ? ` — ${detail}` : ""}`); failed++; }
}

async function main() {
    const stamp = Date.now();
    const id1 = `smoke-pb6-a-${stamp}`;
    const id2 = `smoke-pb6-b-${stamp}`;
    const cleanup = [id1, id2];

    try {
        // 1. First insert succeeds.
        await prisma.webhookDelivery.create({ data: { messageId: id1, source: "gmail" } });
        const row = await prisma.webhookDelivery.findUnique({ where: { messageId: id1 } });
        check("fresh messageId is stored", row !== null && row.source === "gmail");

        // 2. Second insert of same messageId throws P2002.
        let p2002 = false;
        try {
            await prisma.webhookDelivery.create({ data: { messageId: id1, source: "gmail" } });
        } catch (e: any) {
            if (e?.code === "P2002") p2002 = true;
            else throw e;
        }
        check("duplicate messageId throws P2002", p2002);

        // 3. Different messageId is independent.
        await prisma.webhookDelivery.create({ data: { messageId: id2, source: "gmail" } });
        const row2 = await prisma.webhookDelivery.findUnique({ where: { messageId: id2 } });
        check("different messageId is independent", row2 !== null);
    } finally {
        for (const id of cleanup) {
            await prisma.webhookDelivery.delete({ where: { messageId: id } }).catch(() => {});
        }
        await prisma.$disconnect();
    }

    console.log(`\n${passed}/${passed + failed} steps passed`);
    if (failed > 0) process.exit(1);
    console.log("All checks passed.");
}

main().catch(e => { console.error(e); process.exit(1); });
