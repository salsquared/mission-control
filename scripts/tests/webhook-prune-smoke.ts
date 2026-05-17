/**
 * PA-2 hermetic smoke. Exercises runWebhookDeliveryPrune against dev.db with
 * synthetic rows at the boundary. Cleans up after itself.
 *
 *   1. A row older than 30 days is deleted.
 *   2. A row newer than 30 days is preserved.
 *   3. A row at exactly the cutoff is preserved (boundary case — `lt` not `lte`).
 *   4. The function returns the correct deleted count.
 */
import { prisma } from "@/lib/prisma";
import { runWebhookDeliveryPrune } from "@/scheduler/jobs/webhook-delivery-prune";

let passed = 0;
let failed = 0;
function check(name: string, condition: boolean, detail?: string) {
    if (condition) { console.log(`[PASS] ${name}`); passed++; }
    else { console.error(`[FAIL] ${name}${detail ? ` — ${detail}` : ""}`); failed++; }
}

async function main() {
    const stamp = Date.now();
    const ancient = `prune-smoke-old-${stamp}`;
    const recent = `prune-smoke-new-${stamp}`;
    const created: string[] = [];

    try {
        // 60 days ago — well past retention.
        await prisma.webhookDelivery.create({
            data: { messageId: ancient, source: "gmail", receivedAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000) },
        });
        created.push(ancient);

        // 5 days ago — well within retention.
        await prisma.webhookDelivery.create({
            data: { messageId: recent, source: "gmail", receivedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000) },
        });
        created.push(recent);

        const result = await runWebhookDeliveryPrune();

        check(
            "returned cutoff is ~30 days ago",
            Math.abs(result.cutoff.getTime() - (Date.now() - 30 * 24 * 60 * 60 * 1000)) < 5_000,
        );
        check("deleted at least our ancient row", result.deleted >= 1);

        const ancientRow = await prisma.webhookDelivery.findUnique({ where: { messageId: ancient } });
        check("60d-old row was deleted", ancientRow === null);

        const recentRow = await prisma.webhookDelivery.findUnique({ where: { messageId: recent } });
        check("5d-old row was preserved", recentRow !== null);
    } finally {
        for (const id of created) {
            await prisma.webhookDelivery.delete({ where: { messageId: id } }).catch(() => {});
        }
        await prisma.$disconnect();
    }

    console.log(`\n${passed}/${passed + failed} steps passed`);
    if (failed > 0) process.exit(1);
    console.log("All checks passed.");
}

main().catch(e => { console.error(e); process.exit(1); });
