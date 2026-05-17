/**
 * PB-8 hermetic smoke. Verifies:
 *
 *   1. First dispatch with a dedupKey succeeds (returns a row).
 *   2. Second dispatch with the SAME dedupKey returns null (no row created).
 *   3. Different dedupKeys for the same (userId, kind) are independent.
 *   4. Two concurrent dispatches (Promise.all) with the same key: exactly one
 *      wins. The other returns null. No exception escapes.
 *   5. utcDateBucket is stable inside a single tick and uses YYYY-MM-DD UTC.
 *
 * Cleans up its own rows. EMAIL_ENABLED=0 expected from the pre-push hook so
 * we don't actually fire emails for tier='critical' here.
 */
import { prisma } from "@/lib/prisma";
import { dispatchNotification, utcDateBucket } from "@/lib/notifications/dispatch";

let passed = 0;
let failed = 0;
function check(name: string, condition: boolean, detail?: string) {
    if (condition) { console.log(`[PASS] ${name}`); passed++; }
    else { console.error(`[FAIL] ${name}${detail ? ` — ${detail}` : ""}`); failed++; }
}

async function main() {
    const user = await prisma.user.findFirst();
    if (!user) { console.error("No user — log in first."); process.exit(1); }

    const stamp = Date.now();
    const keyA = `pb8-smoke-${stamp}-a`;
    const keyB = `pb8-smoke-${stamp}-b`;
    const keyConcurrent = `pb8-smoke-${stamp}-concurrent`;

    try {
        // 1. First dispatch with dedupKey → row created.
        const first = await dispatchNotification({
            userId: user.id, tier: "low", kind: "system",
            title: "[pb8 smoke] first", payload: { test: true },
            dedupKey: keyA,
        });
        check("first dispatch with dedupKey returns row", first !== null);
        check("first dispatch row has matching dedupKey", first?.dedupKey === keyA);

        // 2. Second dispatch with same dedupKey → null (no row).
        const second = await dispatchNotification({
            userId: user.id, tier: "low", kind: "system",
            title: "[pb8 smoke] second (should be dropped)", payload: { test: true },
            dedupKey: keyA,
        });
        check("second dispatch with SAME dedupKey returns null", second === null);

        // Verify there's exactly one row in the DB for that key.
        const rows = await prisma.notification.findMany({ where: { dedupKey: keyA } });
        check("exactly one row exists for the dedupKey", rows.length === 1);

        // 3. Different dedupKey is independent.
        const independent = await dispatchNotification({
            userId: user.id, tier: "low", kind: "system",
            title: "[pb8 smoke] different key", payload: { test: true },
            dedupKey: keyB,
        });
        check("different dedupKey returns a new row", independent !== null && independent.id !== first?.id);

        // 4. Concurrent dispatches with same key — exactly one wins.
        const [r1, r2] = await Promise.all([
            dispatchNotification({
                userId: user.id, tier: "low", kind: "system",
                title: "[pb8 smoke] race a", payload: { test: true },
                dedupKey: keyConcurrent,
            }),
            dispatchNotification({
                userId: user.id, tier: "low", kind: "system",
                title: "[pb8 smoke] race b", payload: { test: true },
                dedupKey: keyConcurrent,
            }),
        ]);
        const winners = [r1, r2].filter(r => r !== null).length;
        check("concurrent: exactly one dispatcher wins", winners === 1, `got ${winners} winners`);
        const concurrentRows = await prisma.notification.findMany({ where: { dedupKey: keyConcurrent } });
        check("concurrent: exactly one DB row exists", concurrentRows.length === 1);

        // 5. utcDateBucket sanity.
        const today = utcDateBucket();
        check("utcDateBucket returns YYYY-MM-DD", /^\d{4}-\d{2}-\d{2}$/.test(today));
        const fixed = utcDateBucket(new Date("2026-05-17T23:00:00Z"));
        check("utcDateBucket honors the passed Date", fixed === "2026-05-17");
    } finally {
        await prisma.notification.deleteMany({
            where: { dedupKey: { in: [keyA, keyB, keyConcurrent] } },
        }).catch(() => undefined);
        await prisma.$disconnect();
    }

    console.log(`\n${passed}/${passed + failed} steps passed`);
    if (failed > 0) process.exit(1);
    console.log("All checks passed.");
}

main().catch(e => { console.error(e); process.exit(1); });
