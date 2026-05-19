/**
 * Live smoke for the auto-run-on-create behavior. Uses an invalid Greenhouse
 * slug so the fetcher fails fast — lastError will be set, lastRunAt will be
 * set, no real JobPosting rows are created. We're just verifying the
 * fire-and-forget runWatchlist call actually fires.
 *
 *   DATABASE_URL="file:./dev.db" npx tsx /tmp/watchlist-auto-run-smoke.ts
 */
import { PrismaClient } from "@prisma/client";
import { randomBytes } from "crypto";

const BASE = "http://localhost:4101";
const prisma = new PrismaClient();

async function main() {
    const user = await prisma.user.findFirst();
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
            console.error(`[FAIL] POST /api/watchlists → ${createRes.status}`, createBody);
            process.exit(1);
        }
        watchlistId = createBody.watchlist.id;
        const tCreate = Date.now() - t0;
        console.log(`[PASS] POST /api/watchlists returned in ${tCreate}ms (id=${watchlistId})`);
        console.log(`       scheduleMinutes=${createBody.watchlist.scheduleMinutes} (expected 240 from schema default)`);
        if (createBody.watchlist.scheduleMinutes !== 240) {
            console.error(`[FAIL] schema default not 240`);
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
            console.error(`[FAIL] lastRunAt never populated — auto-run never fired`);
            process.exit(1);
        }
    } finally {
        if (watchlistId) {
            await prisma.jobPosting.deleteMany({ where: { watchlistId } }).catch(() => undefined);
            await prisma.watchlist.delete({ where: { id: watchlistId } }).catch(() => undefined);
        }
        await prisma.session.delete({ where: { sessionToken } }).catch(() => undefined);
        await prisma.$disconnect();
    }
}

main().catch(e => {
    console.error("Unhandled:", e);
    process.exit(2);
});
