/**
 * Audit item #2 hermetic smoke. Exercises runNotificationPrune against dev.db
 * with synthetic rows at the retention boundary and around the critical
 * carve-out. Cleans up after itself.
 *
 *   1. A row older than 90 days is deleted.
 *   2. A row newer than 90 days is preserved.
 *   3. The returned cutoff is ~90 days ago.
 *   4. An OLD unread + undismissed CRITICAL is preserved (the bell pins these
 *      outside the recency window — see the carve-out in the job file).
 *   5. An OLD *read* critical IS deleted (it is no longer pinned).
 *   6. An OLD *dismissed* critical IS deleted (dismissal is the user saying
 *      they're done with it), even though it is still unread.
 *   7. A RECENT unread critical is preserved (retention, not the carve-out).
 *   8. A dedupKey freed by the prune no longer suppresses a re-dispatch, and
 *      one still held by a preserved row still does — the property the job's
 *      recurrence analysis turns on.
 *
 * Assertions are scoped to this run's own synthetic rows, so the result does
 * not depend on what real rows dev.db happens to hold. Note the run also
 * sweeps any genuinely >90-day-old rows in dev.db — that is the job's intended
 * behavior, same as webhook-prune-smoke.ts.
 */
import { prisma } from "@/lib/prisma";
import { runNotificationPrune } from "@/scheduler/jobs/notification-prune";
import { dispatchNotification } from "@/lib/notifications/dispatch";

let passed = 0;
let failed = 0;
function check(name: string, condition: boolean, detail?: string) {
    if (condition) { console.log(`[PASS] ${name}`); passed++; }
    else { console.error(`[FAIL] ${name}${detail ? ` — ${detail}` : ""}`); failed++; }
}

const DAY = 24 * 60 * 60 * 1000;

async function main() {
    const user = await prisma.user.findFirst();
    if (!user) { console.error("No user — log in first."); process.exit(1); }

    const stamp = Date.now();
    const keys: string[] = [];

    // 120 days ago — well past retention. 5 days ago — well within it.
    const ancient = new Date(stamp - 120 * DAY);
    const recent = new Date(stamp - 5 * DAY);

    async function seed(
        label: string,
        opts: { createdAt: Date; tier: string; readAt?: Date | null; dismissedAt?: Date | null },
    ): Promise<string> {
        const dedupKey = `notif-prune-smoke-${stamp}-${label}`;
        await prisma.notification.create({
            data: {
                userId: user!.id,
                kind: "system",
                tier: opts.tier,
                title: `[notif-prune smoke] ${label}`,
                payload: JSON.stringify({ test: true }),
                createdAt: opts.createdAt,
                readAt: opts.readAt ?? null,
                dismissedAt: opts.dismissedAt ?? null,
                dedupKey,
            },
        });
        keys.push(dedupKey);
        return dedupKey;
    }

    async function exists(dedupKey: string): Promise<boolean> {
        return (await prisma.notification.findUnique({ where: { dedupKey } })) !== null;
    }

    try {
        const oldLow = await seed("old-low", { createdAt: ancient, tier: "low" });
        const newLow = await seed("new-low", { createdAt: recent, tier: "low" });
        const oldCritUnread = await seed("old-critical-unread", { createdAt: ancient, tier: "critical" });
        const oldCritRead = await seed("old-critical-read", {
            createdAt: ancient, tier: "critical", readAt: new Date(stamp - 100 * DAY),
        });
        const oldCritDismissed = await seed("old-critical-dismissed", {
            createdAt: ancient, tier: "critical", dismissedAt: new Date(stamp - 100 * DAY),
        });
        const newCritUnread = await seed("new-critical-unread", { createdAt: recent, tier: "critical" });
        const oldStandard = await seed("old-standard", { createdAt: ancient, tier: "standard" });

        const result = await runNotificationPrune();

        check(
            "returned cutoff is ~90 days ago",
            Math.abs(result.cutoff.getTime() - (Date.now() - 90 * DAY)) < 5_000,
            `got ${result.cutoff.toISOString()}`,
        );
        check("deleted count covers at least our aged rows", result.deleted >= 4, `deleted=${result.deleted}`);

        check("120d-old low row was deleted", !(await exists(oldLow)));
        check("5d-old low row was preserved", await exists(newLow));
        check("120d-old standard row was deleted", !(await exists(oldStandard)));

        // The carve-out: the bell pins unread+undismissed criticals with no
        // date bound, so the prune must not be able to remove one.
        check("120d-old UNREAD critical was PRESERVED (pinned)", await exists(oldCritUnread));
        check("120d-old READ critical was deleted", !(await exists(oldCritRead)));
        check("120d-old DISMISSED critical was deleted", !(await exists(oldCritDismissed)));
        check("5d-old unread critical was preserved", await exists(newCritUnread));

        // dedupKey suppression is the row itself: a freed key must re-fire, a
        // held key must still suppress. This is the property the job's
        // recurrence analysis depends on being true.
        const refired = await dispatchNotification({
            userId: user.id, tier: "low", kind: "system",
            title: "[notif-prune smoke] refire after prune", payload: { test: true },
            dedupKey: oldLow,
        });
        check("dedupKey freed by the prune no longer suppresses", refired !== null);

        const stillSuppressed = await dispatchNotification({
            userId: user.id, tier: "low", kind: "system",
            title: "[notif-prune smoke] should be suppressed", payload: { test: true },
            dedupKey: newLow,
        });
        check("dedupKey held by a preserved row still suppresses", stillSuppressed === null);
    } finally {
        for (const dedupKey of keys) {
            await prisma.notification.deleteMany({ where: { dedupKey } }).catch(() => {});
        }
        await prisma.$disconnect();
    }

    console.log(`\n${passed}/${passed + failed} steps passed`);
    if (failed > 0) process.exit(1);
    console.log("All checks passed.");
}

main().catch(e => { console.error(e); process.exit(1); });
