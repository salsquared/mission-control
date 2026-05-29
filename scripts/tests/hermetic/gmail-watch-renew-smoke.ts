/**
 * Hermetic smoke for the Gmail watch-renewal scheduler job
 * (scheduler/jobs/gmail-watch-renew.ts). Exercises account SELECTION + per-user
 * dedup + error ISOLATION against dev.db with an injected stub register fn — no
 * live Gmail API. Cleans up after itself.
 *
 *   Selection / dedup (stub records calls):
 *     1. A google account WITH a refresh_token is re-armed.
 *     2. A google account WITHOUT a refresh_token is skipped.
 *     3. A non-google account (with a token) is skipped.
 *     4. A user with TWO google accounts is armed exactly once (Set dedup).
 *   Error isolation (stub throws for one user):
 *     5. One user throwing does not abort the sweep — a sibling still arms.
 *     6. The thrown user is counted in `failed`, not `renewed`.
 *
 * NOTE: dev.db may carry a real google account (the dev user), so the run's
 * absolute `processed`/`renewed` totals are not asserted — only membership /
 * counts scoped to the seeded test users, which is deterministic regardless.
 */
import { prisma } from "@/lib/prisma";
import { runGmailWatchRenew } from "@/scheduler/jobs/gmail-watch-renew";

let passed = 0;
let failed = 0;
function check(name: string, condition: boolean, detail?: string) {
    if (condition) { console.log(`[PASS] ${name}`); passed++; }
    else { console.error(`[FAIL] ${name}${detail ? ` — ${detail}` : ""}`); failed++; }
}

async function main() {
    const stamp = Date.now();
    const U = {
        A: `gw-smoke-${stamp}-A`,   // google + refresh (+ a 2nd google acct → dedup)
        B: `gw-smoke-${stamp}-B`,   // google, NO refresh → skipped
        C: `gw-smoke-${stamp}-C`,   // non-google + token → skipped
        E: `gw-smoke-${stamp}-E`,   // google + refresh → isolation control
    };
    const userIds = Object.values(U);

    try {
        // Users first (Account.userId FK; cascade on delete).
        for (const [k, id] of Object.entries(U)) {
            await prisma.user.create({ data: { id, email: `${id}@test.local`, name: `gw-smoke ${k}` } });
        }
        // Accounts.
        await prisma.account.createMany({
            data: [
                { id: `${U.A}-acct1`, userId: U.A, type: "oauth", provider: "google", providerAccountId: `${U.A}-1`, refresh_token: "rt-A1" },
                { id: `${U.A}-acct2`, userId: U.A, type: "oauth", provider: "google", providerAccountId: `${U.A}-2`, refresh_token: "rt-A2" }, // dedup
                { id: `${U.B}-acct1`, userId: U.B, type: "oauth", provider: "google", providerAccountId: `${U.B}-1`, refresh_token: null },     // no refresh
                { id: `${U.C}-acct1`, userId: U.C, type: "oauth", provider: "github", providerAccountId: `${U.C}-1`, refresh_token: "rt-C1" },  // non-google
                { id: `${U.E}-acct1`, userId: U.E, type: "oauth", provider: "google", providerAccountId: `${U.E}-1`, refresh_token: "rt-E1" },
            ],
        });

        // --- Scenario 1: selection + dedup ---
        const calls = new Map<string, number>();
        const okStub = async (userId: string) => {
            calls.set(userId, (calls.get(userId) ?? 0) + 1);
            return { historyId: "100", expiration: "200" };
        };
        const r1 = await runGmailWatchRenew(okStub);

        check("1. google + refresh_token is armed", calls.get(U.A) === 1, `calls(A)=${calls.get(U.A)}`);
        check("2. google WITHOUT refresh_token is skipped", !calls.has(U.B));
        check("3. non-google account is skipped", !calls.has(U.C));
        check("4. two google accounts → armed exactly once", calls.get(U.A) === 1);
        check("control user (E) armed once", calls.get(U.E) === 1, `calls(E)=${calls.get(U.E)}`);
        check("renewed counts our successes (>= A,E)", r1.renewed >= 2, `renewed=${r1.renewed}`);
        check("processed >= our two refresh users", r1.processed >= 2, `processed=${r1.processed}`);

        // --- Scenario 2: per-user error isolation ---
        const calls2 = new Map<string, number>();
        const throwForAStub = async (userId: string) => {
            calls2.set(userId, (calls2.get(userId) ?? 0) + 1);
            if (userId === U.A) throw new Error("simulated watch failure");
            return { historyId: "100", expiration: "200" };
        };
        let threw = false;
        let r2: Awaited<ReturnType<typeof runGmailWatchRenew>> | null = null;
        try {
            r2 = await runGmailWatchRenew(throwForAStub);
        } catch {
            threw = true;
        }

        check("5a. a throwing user does not abort the sweep", !threw);
        check("5b. sibling user (E) still armed after A threw", calls2.get(U.E) === 1, `calls2(E)=${calls2.get(U.E)}`);
        check("6a. thrown user counted in failed (>= 1)", (r2?.failed ?? 0) >= 1, `failed=${r2?.failed}`);
        check("6b. successes still counted in renewed (>= 1)", (r2?.renewed ?? 0) >= 1, `renewed=${r2?.renewed}`);
    } finally {
        // Cascade would remove accounts on user delete, but be explicit.
        await prisma.account.deleteMany({ where: { userId: { in: userIds } } });
        await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    await prisma.$disconnect();
    if (failed > 0) process.exit(1);
}

main().catch(async (e) => {
    console.error("Unhandled:", e);
    await prisma.$disconnect();
    process.exit(2);
});
