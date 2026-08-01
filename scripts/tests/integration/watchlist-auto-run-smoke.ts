/**
 * Live smoke for the auto-run-on-create behavior. Uses an invalid Greenhouse
 * slug so the fetcher fails fast — lastError will be set, lastRunAt will be
 * set, no real JobPosting rows are created. We're just verifying the
 * fire-and-forget runWatchlist call actually fires.
 *
 *   DATABASE_URL="file:./dev.db" npx tsx scripts/tests/integration/watchlist-auto-run-smoke.ts
 */
import { PrismaClient } from "@prisma/client";
import { randomBytes } from "crypto";

// `MC_BASE_URL` matches the sibling smokes (profile-import, resume-archival)
// and scripts/test-integration.sh, which reads the same var for its pre-flight.
const BASE = process.env.MC_BASE_URL ?? "http://localhost:4101";
const prisma = new PrismaClient();

/** Counted here, reported by `finish()` at the bottom — never `process.exit`ed inside `main()`. */
let fails = 0;

async function main() {
    // Pinned to the OWNER deliberately. The dev break-glass resolves every
    // request to the owner, so a fixture created as anyone else disagrees with
    // the identity the handlers will see. An unpinned findFirst() returns an
    // arbitrary row, and dev.db has held crew rows since 2026-08-01 — it still
    // happens to return the owner by insertion order, which is luck, not design.
    const user = await prisma.user.findFirst({ where: { role: "owner" } });
    if (!user) throw new Error("No user");
    console.log(`User: ${user.email}`);

    const sessionToken = randomBytes(32).toString("hex");
    await prisma.session.create({
        data: { sessionToken, userId: user.id, expires: new Date(Date.now() + 60 * 60 * 1000) },
    });
    const cookie = `__Secure-next-auth.session-token=${sessionToken}`;
    const headers = { "Content-Type": "application/json", Cookie: cookie };

    let watchlistId = "";
    try {
        const t0 = Date.now();
        const createRes = await fetch(`${BASE}/api/watchlists`, {
            method: "POST",
            headers,
            body: JSON.stringify({
                name: `auto-run-smoke-${Date.now()}`,
                config: {
                    kind: "greenhouse",
                    boardSlug: "this-slug-definitely-does-not-exist-xyz-test",
                    companyName: "auto-run-smoke-target",
                },
                // NO scheduleMinutes — verifies the new 240 default
            }),
        });
        const createBody = await createRes.json();
        if (createRes.status !== 200) {
            // `return`, NOT `process.exit(1)` — see the note on `finish()`.
            // Nothing is orphaned on THIS branch (no watchlist yet), but an
            // exit here still skips the scratch Session delete and the
            // `$disconnect()` below.
            console.error(`[FAIL] POST /api/watchlists → ${createRes.status}`, createBody);
            fails++;
            return;
        }
        watchlistId = createBody.watchlist.id;
        const tCreate = Date.now() - t0;
        console.log(`[PASS] POST /api/watchlists returned in ${tCreate}ms (id=${watchlistId})`);
        console.log(`       scheduleMinutes=${createBody.watchlist.scheduleMinutes} (expected 240 from schema default)`);
        if (createBody.watchlist.scheduleMinutes !== 240) {
            // Counted, not just printed. Before `fails` existed this branch
            // printed [FAIL] and then fell through to exit 0 — a false green
            // of exactly the family fixed in 4ca1d0a.
            console.error(`[FAIL] schema default not 240 (got ${createBody.watchlist.scheduleMinutes})`);
            fails++;
        }
        if (createBody.watchlist.lastRunAt !== null) {
            console.log(`       lastRunAt already set at response time (auto-run completed before response): ${createBody.watchlist.lastRunAt}`);
        }

        // Poll for lastRunAt to populate. Auto-run is fire-and-forget so the
        // response returns before the run completes. Greenhouse 404 should
        // resolve in <2s.
        for (let i = 0; i < 30; i++) {
            const row = await prisma.watchlist.findUnique({ where: { id: watchlistId } });
            if (row?.lastRunAt) {
                const tRun = Date.now() - t0;
                console.log(`[PASS] lastRunAt populated after ${tRun}ms (${tRun - tCreate}ms post-response)`);
                console.log(`       lastError: ${row.lastError ?? "(none)"}`);
                console.log(`       lastSuccessAt: ${row.lastSuccessAt?.toISOString() ?? "(none — fetch errored as expected)"}`);
                console.log(`       expected: lastError populated (Greenhouse 404 on bogus slug), lastSuccessAt null`);
                break;
            }
            await new Promise(r => setTimeout(r, 500));
        }
        const final = await prisma.watchlist.findUnique({ where: { id: watchlistId } });
        if (!final?.lastRunAt) {
            // THE BRANCH THAT USED TO LITTER. `watchlistId` is populated by
            // now, so the old `process.exit(1)` here skipped the finally and
            // orphaned the scratch watchlist. `return` runs it.
            console.error(`[FAIL] lastRunAt never populated — auto-run never fired`);
            fails++;
            return;
        }
    } finally {
        // THIS BLOCK IS WHY THE BRANCHES ABOVE `return` INSTEAD OF EXITING.
        // The scratch Watchlist is not inert test litter — a surviving row is
        // a LIVE standing crawl that both schedulers keep picking up against
        // this DB, forever.
        if (watchlistId) {
            await prisma.jobPosting.deleteMany({ where: { watchlistId } }).catch(() => undefined);
            try {
                await prisma.watchlist.delete({ where: { id: watchlistId } });
            } catch (e) {
                // Never swallow THIS one. A silently-failed delete leaves the
                // same live standing crawl the `return`s exist to prevent, so
                // it has to be loud and it has to fail the run.
                console.error(
                    `[FAIL] cleanup could not delete scratch watchlist ${watchlistId} — ` +
                    `it is a LIVE standing crawl in this DB until removed by hand (Watchlist id=${watchlistId})`,
                    e,
                );
                fails++;
            }
        }
        await prisma.session.delete({ where: { sessionToken } }).catch(() => undefined);
        await prisma.$disconnect();
    }
}

/**
 * THE EXIT PATH LIVES OUT HERE — DO NOT MOVE IT BACK INTO `main()`.
 *
 * Both failure branches in `main()` used to be a bare `process.exit(1)` inside
 * the try, and `process.exit()` does not run pending `finally` blocks — so the
 * red path skipped its own cleanup. The second one (lastRunAt never populated)
 * ran with the scratch watchlist already created, orphaning it; and an orphaned
 * Watchlist row is not dead litter, it is a live standing crawl the schedulers
 * keep re-running against dev.db. (The first one leaked the scratch Session row
 * and skipped `$disconnect()`.) Counting into `fails` and `return`ing lets the
 * finally sweep; running the verdict from `.then()` means no early exit can
 * dodge the exit code either. Same fix as profile-import-smoke.ts in 4ca1d0a.
 */
function finish(): never {
    if (fails > 0) {
        console.error(`\n[FAIL] ${fails} check(s) failed`);
        process.exit(1);
    }
    console.log("\n[PASS] all checks passed");
    process.exit(0);
}

main().then(finish, e => {
    console.error("Unhandled:", e);
    process.exit(2);
});
