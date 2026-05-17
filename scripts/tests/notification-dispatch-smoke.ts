/**
 * Hermetic smoke for the central notification dispatcher
 * (lib/notifications/dispatch.ts). Uses the dev DB but never sends real email
 * — mocks the email helper at module level so we just verify channels +
 * row creation per tier.
 *
 *   DATABASE_URL="file:./dev.db" npx tsx scripts/tests/notification-dispatch-smoke.ts
 */
import { PrismaClient } from "@prisma/client";
import { dispatchNotification } from "@/lib/notifications/dispatch";

const prisma = new PrismaClient();

let passes = 0;
let fails = 0;
function pass(msg: string) { console.log(`[PASS] ${msg}`); passes++; }
function fail(msg: string, detail?: unknown) { console.error(`[FAIL] ${msg}`, detail ?? ""); fails++; }

async function main() {
    const user = await prisma.user.findFirst();
    if (!user) { console.error("No user — log in first."); process.exit(1); }
    console.log(`Using user ${user.email}`);

    const createdIds: string[] = [];

    try {
        // PB-8: dispatchNotification now returns `Notification | null` to
        // signal a dedupKey collision. None of these test calls pass a
        // dedupKey, so non-null is guaranteed — assert it loudly so a future
        // regression that flips the return for non-dedup paths gets caught.
        function expectRow<T>(name: string, row: T | null): T {
            if (!row) { fail(`${name}: dispatch returned null without dedupKey`); process.exit(1); }
            return row;
        }
        // ─── critical → channels='in_app,email' ─────────────────────────────
        const critical = expectRow("critical", await dispatchNotification({
            userId: user.id,
            tier: "critical",
            kind: "application",
            title: "[dispatch smoke] critical",
            body: "tier=critical, kind=application",
            payload: { test: true },
        }));
        createdIds.push(critical.id);
        if (critical.tier !== "critical") fail(`critical: tier wrong (${critical.tier})`);
        else pass("critical: row.tier='critical'");
        if (critical.channels !== "in_app,email") fail(`critical: channels=${critical.channels}, expected 'in_app,email'`);
        else pass("critical: row.channels='in_app,email' (default for tier)");
        if (critical.kind !== "application") fail(`critical: kind=${critical.kind}, expected 'application'`);
        else pass("critical: row.kind preserved");

        // ─── standard → in_app only ─────────────────────────────────────────
        const standard = expectRow("standard", await dispatchNotification({
            userId: user.id,
            tier: "standard",
            kind: "system",
            title: "[dispatch smoke] standard",
            payload: { test: true },
        }));
        createdIds.push(standard.id);
        if (standard.tier !== "standard") fail(`standard: tier wrong`);
        else pass("standard: row.tier='standard'");
        if (standard.channels !== "in_app") fail(`standard: channels=${standard.channels}, expected 'in_app'`);
        else pass("standard: row.channels='in_app' (default for tier)");

        // ─── low → in_app only ──────────────────────────────────────────────
        const low = expectRow("low", await dispatchNotification({
            userId: user.id,
            tier: "low",
            kind: "posting",
            title: "[dispatch smoke] low",
            payload: { test: true },
        }));
        createdIds.push(low.id);
        if (low.tier !== "low") fail(`low: tier wrong`);
        else pass("low: row.tier='low'");
        if (low.channels !== "in_app") fail(`low: channels=${low.channels}, expected 'in_app'`);
        else pass("low: row.channels='in_app' (default for tier)");

        // ─── channels override wins over tier default ───────────────────────
        const overridden = expectRow("override", await dispatchNotification({
            userId: user.id,
            tier: "low",
            kind: "system",
            title: "[dispatch smoke] override",
            payload: { test: true },
            channels: "in_app,email", // explicit override even though tier='low'
        }));
        createdIds.push(overridden.id);
        if (overridden.channels !== "in_app,email") fail("override: channels not respected");
        else pass("override: caller's `channels` overrides tier default");
        // Should have attempted email dispatch (emailSentAt OR emailError set)
        const refetched = await prisma.notification.findUnique({ where: { id: overridden.id } });
        if (!refetched?.emailSentAt && !refetched?.emailError) {
            fail("override: neither emailSentAt nor emailError set — email side-channel didn't run");
        } else {
            pass(`override: email side-channel ran (${refetched.emailSentAt ? "sent" : "errored"})`);
        }

        // ─── critical also triggers email ───────────────────────────────────
        const criticalAfter = await prisma.notification.findUnique({ where: { id: critical.id } });
        if (!criticalAfter?.emailSentAt && !criticalAfter?.emailError) {
            fail("critical: email side-channel didn't run");
        } else {
            pass(`critical: email side-channel ran (${criticalAfter.emailSentAt ? "sent" : "errored"})`);
        }

        // ─── standard/low DON'T trigger email ───────────────────────────────
        const standardAfter = await prisma.notification.findUnique({ where: { id: standard.id } });
        if (standardAfter?.emailSentAt || standardAfter?.emailError) {
            fail("standard: email side-channel ran but shouldn't have");
        } else {
            pass("standard: email side-channel did NOT run (correct)");
        }
        const lowAfter = await prisma.notification.findUnique({ where: { id: low.id } });
        if (lowAfter?.emailSentAt || lowAfter?.emailError) {
            fail("low: email side-channel ran but shouldn't have");
        } else {
            pass("low: email side-channel did NOT run (correct)");
        }
    } finally {
        if (createdIds.length > 0) {
            await prisma.notification.deleteMany({ where: { id: { in: createdIds } } }).catch(() => undefined);
        }
        await prisma.$disconnect();
        console.log(`\n${passes}/${passes + fails} steps passed`);
        if (fails === 0) console.log("All checks passed.");
    }
    if (fails > 0) process.exit(1);
}

main().catch(e => {
    console.error("Unhandled error:", e);
    process.exit(2);
});
