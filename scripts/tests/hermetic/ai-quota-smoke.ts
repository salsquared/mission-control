/**
 * Hermetic smoke for the per-user daily Gemini credit counter
 * (lib/ai/quota.ts — docs/multi-user-crew.html §2.9 / OQ7a, task P2.5).
 *
 *   npx tsx scripts/tests/hermetic/ai-quota-smoke.ts
 *
 * Asserts:
 *   1. OWNER IS UNLIMITED — far more calls than any crew limit, every one
 *      granted, `limit === Infinity`, and NOT ONE AiUsage row written. The
 *      owner's spend is the thing the crew cap protects; metering it would be
 *      backwards, and a row would mean the exempt path touches the DB.
 *   2. CREW REFUSED AT N+1 — N grants reporting used 1..N, then refusal at
 *      N+1 with `{ ok: false, used: N, limit: N }`. Repeated refusals do NOT
 *      keep incrementing, so the 429 body can never say "used 47 of 3".
 *   3. THE DAY BUCKET ROLLS OVER — both halves: utcDateBucket() flips across
 *      UTC midnight (and NOT at local midnight), and a user whose only row
 *      belongs to a previous bucket starts the new day at used=1 with the old
 *      row preserved.
 *   4. TWO CREW MEMBERS HAVE INDEPENDENT COUNTERS — one exhausting their
 *      allowance leaves the other's untouched, and vice versa.
 *   5. CONCURRENCY AT THE BOUNDARY — limit+4 consumes fired simultaneously
 *      yield EXACTLY `limit` grants. A read-then-write implementation loses
 *      updates here; the single-statement guarded upsert does not.
 *   6. CREW_AI_DAILY_LIMIT=0 refuses without writing a row (the INSERT arm of
 *      the upsert is not covered by its own WHERE guard — the explicit
 *      short-circuit in consumeAiCredit is what makes 0 mean 0).
 *   7. THE 429 CONTRACT (task P3.6 renders this body) — status, `code`,
 *      `stage`, `used`, `limit`, and a positive Retry-After.
 *
 * Genuinely hermetic: no network, no PM2, no Gemini, no server. The DB is a
 * THROWAWAY SQLite file in /tmp (DATABASE_URL pinned before any import; tables
 * created with raw DDL mirroring
 * prisma/migrations/20260728053644_add_user_role_and_ai_usage). dev.db /
 * prod.db are never touched, and no AI module beyond lib/ai/quota.ts is loaded.
 */
const TMP_DB = `/tmp/ai-quota-smoke-${process.pid}-${Date.now()}.db`;
process.env.DATABASE_URL = `file:${TMP_DB}`;
process.env.EMAIL_ENABLED = "0";

import { unlinkSync } from "node:fs";

let passes = 0;
let fails = 0;
function pass(msg: string) { console.log(`[PASS] ${msg}`); passes++; }
function fail(msg: string, detail?: unknown) { console.error(`[FAIL] ${msg}`, detail ?? ""); fails++; }

/**
 * Route handlers' inferred return type carries a phantom `| undefined`
 * (pre-existing codebase-wide TS quirk — untouched routes show it too); at
 * runtime every path returns a NextResponse. Same helper as
 * user-scoping-smoke.ts.
 */
function mustRespond<T>(r: T | undefined, label: string): T {
    if (r === undefined) throw new Error(`${label} returned undefined`);
    return r;
}

const DDL = [
    // Mirrors the migration's redefined User table. The `role` column is NOT
    // NULL, so omitting it here fails every prisma.user.create() with P2022 —
    // this DDL is hand-maintained and does not track prisma/schema.prisma.
    `CREATE TABLE "User" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "name" TEXT,
        "email" TEXT,
        "emailVerified" DATETIME,
        "image" TEXT,
        "lastSyncedHistoryId" TEXT,
        "role" TEXT NOT NULL DEFAULT 'crew'
    )`,
    `CREATE UNIQUE INDEX "User_email_key" ON "User"("email")`,
    `CREATE TABLE "AiUsage" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "userId" TEXT NOT NULL,
        "day" TEXT NOT NULL,
        "count" INTEGER NOT NULL DEFAULT 0,
        CONSTRAINT "AiUsage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
    )`,
    // The upsert key consumeAiCredit's ON CONFLICT targets. Without it the
    // statement errors ("ON CONFLICT clause does not match any PRIMARY KEY or
    // UNIQUE constraint") and the fail-open branch would silently pass tests.
    `CREATE UNIQUE INDEX "AiUsage_userId_day_key" ON "AiUsage"("userId", "day")`,
];

async function main() {
    // Dynamic imports: DATABASE_URL must be pinned before lib/prisma loads.
    const { prisma } = await import("@/lib/prisma");
    for (const ddl of DDL) await prisma.$executeRawUnsafe(ddl);

    const {
        consumeAiCredit,
        aiQuotaExceededResponse,
        crewAiDailyLimit,
        DEFAULT_CREW_AI_DAILY_LIMIT,
    } = await import("@/lib/ai/quota");
    const { utcDateBucket } = await import("@/lib/notifications/dispatch");

    const OWNER = "owner-ai-quota-smoke";
    const CREW_A = "crew-a-ai-quota-smoke";
    const CREW_B = "crew-b-ai-quota-smoke";

    const usageFor = (userId: string, day = utcDateBucket()) =>
        prisma.aiUsage.findUnique({ where: { userId_day: { userId, day } }, select: { count: true } });

    try {
        await prisma.user.create({ data: { id: OWNER, email: "owner@ai-quota-smoke.invalid", role: "owner" } });
        await prisma.user.create({ data: { id: CREW_A, email: "crew-a@ai-quota-smoke.invalid", role: "crew" } });
        await prisma.user.create({ data: { id: CREW_B, email: "crew-b@ai-quota-smoke.invalid", role: "crew" } });

        // ── 0. The env-var contract ─────────────────────────────────────────
        delete process.env.CREW_AI_DAILY_LIMIT;
        if (crewAiDailyLimit() !== DEFAULT_CREW_AI_DAILY_LIMIT || DEFAULT_CREW_AI_DAILY_LIMIT !== 20) {
            fail(`unset CREW_AI_DAILY_LIMIT should be the documented default 20`, crewAiDailyLimit());
        } else pass("CREW_AI_DAILY_LIMIT unset → default 20/day");

        process.env.CREW_AI_DAILY_LIMIT = "not-a-number";
        if (crewAiDailyLimit() !== DEFAULT_CREW_AI_DAILY_LIMIT) {
            fail("a malformed CREW_AI_DAILY_LIMIT should fall back to the default", crewAiDailyLimit());
        } else pass("malformed CREW_AI_DAILY_LIMIT → falls back to the default (one warn)");

        // ── 1. Owner is unlimited, and never touches the table ──────────────
        process.env.CREW_AI_DAILY_LIMIT = "3";
        let ownerAllOk = true;
        let ownerLimitInfinite = true;
        for (let i = 0; i < 50; i++) {
            const r = await consumeAiCredit(OWNER, "owner");
            if (!r.ok) ownerAllOk = false;
            if (r.limit !== Number.POSITIVE_INFINITY) ownerLimitInfinite = false;
        }
        const ownerRows = await prisma.aiUsage.count({ where: { userId: OWNER } });
        if (!ownerAllOk) fail("owner was refused a credit (must be exempt)");
        else if (!ownerLimitInfinite) fail("owner's limit should be Infinity");
        else if (ownerRows !== 0) fail(`owner wrote ${ownerRows} AiUsage rows (exempt path must not touch the table)`);
        else pass("owner: 50/50 granted at crew limit 3, limit=Infinity, zero AiUsage rows");

        // ── 2. Crew refused at N+1, and refusals don't inflate `used` ───────
        const LIMIT = 3;
        const granted: number[] = [];
        for (let i = 0; i < LIMIT; i++) {
            const r = await consumeAiCredit(CREW_A, "crew");
            if (!r.ok) fail(`crew call ${i + 1}/${LIMIT} refused inside the allowance`, r);
            granted.push(r.used);
        }
        if (granted.join(",") !== "1,2,3") fail("granted calls should report used 1..N", granted);
        else pass(`crew: first ${LIMIT} calls granted, used counts up 1..${LIMIT}`);

        const overA = await consumeAiCredit(CREW_A, "crew");
        if (overA.ok) fail("crew call N+1 should be refused", overA);
        else if (overA.used !== LIMIT || overA.limit !== LIMIT) {
            fail(`refusal should report { used: ${LIMIT}, limit: ${LIMIT} }`, overA);
        } else pass("crew: call N+1 refused with { ok:false, used:3, limit:3 }");

        for (let i = 0; i < 5; i++) await consumeAiCredit(CREW_A, "crew");
        const afterSpam = await usageFor(CREW_A);
        if (afterSpam?.count !== LIMIT) {
            fail(`refused calls must NOT increment — count is ${afterSpam?.count}, expected ${LIMIT}`);
        } else pass("crew: 5 further refusals leave count pinned at the limit (used <= limit always)");

        // ── 3. Two crew members have independent counters ───────────────────
        const b1 = await consumeAiCredit(CREW_B, "crew");
        const b2 = await consumeAiCredit(CREW_B, "crew");
        const aStillOver = await consumeAiCredit(CREW_A, "crew");
        const aCount = (await usageFor(CREW_A))?.count;
        const bCount = (await usageFor(CREW_B))?.count;
        if (!b1.ok || !b2.ok || b2.used !== 2) {
            fail("crew B should have a fresh allowance while crew A is exhausted", { b1, b2 });
        } else if (aStillOver.ok) {
            fail("crew A must remain refused while crew B spends");
        } else if (aCount !== LIMIT || bCount !== 2) {
            fail(`counters leaked across users (A=${aCount} expected ${LIMIT}, B=${bCount} expected 2)`);
        } else pass("two crew members have fully independent counters");

        // ── 4. The day bucket ───────────────────────────────────────────────
        // (a) the helper itself: rolls at UTC midnight, not local midnight.
        const lastSecond = utcDateBucket(new Date("2026-07-27T23:59:59.999Z"));
        const firstSecond = utcDateBucket(new Date("2026-07-28T00:00:00.000Z"));
        const localEvening = utcDateBucket(new Date("2026-07-28T04:30:00.000Z"));
        if (lastSecond !== "2026-07-27" || firstSecond !== "2026-07-28") {
            fail("utcDateBucket must roll at UTC midnight", { lastSecond, firstSecond });
        } else if (localEvening !== "2026-07-28") {
            fail("utcDateBucket must not shift with a local (UTC-n) evening", localEvening);
        } else pass("utcDateBucket rolls at 00:00 UTC and is DST/locale-independent");

        // (b) the counter: relabel crew A's exhausted row to yesterday's bucket
        // — the exact state the process sees one second after midnight — and
        // assert today starts fresh while yesterday's row survives intact.
        const today = utcDateBucket();
        const yesterday = utcDateBucket(new Date(Date.now() - 24 * 60 * 60 * 1000));
        await prisma.aiUsage.update({
            where: { userId_day: { userId: CREW_A, day: today } },
            data: { day: yesterday },
        });
        const newDay = await consumeAiCredit(CREW_A, "crew");
        const yesterdayRow = await usageFor(CREW_A, yesterday);
        if (!newDay.ok || newDay.used !== 1) {
            fail("a new UTC day must start the crew counter at used=1", newDay);
        } else if (yesterdayRow?.count !== LIMIT) {
            fail(`the previous day's row must survive untouched (got ${yesterdayRow?.count})`);
        } else pass("day rollover: new bucket starts at used=1, prior day's row preserved");

        // ── 5. Concurrency at the boundary ──────────────────────────────────
        // A read-then-write implementation loses updates here and over-grants.
        process.env.CREW_AI_DAILY_LIMIT = "5";
        const CONC_USER = "crew-conc-ai-quota-smoke";
        await prisma.user.create({ data: { id: CONC_USER, email: "conc@ai-quota-smoke.invalid", role: "crew" } });
        const results = await Promise.all(
            Array.from({ length: 9 }, () => consumeAiCredit(CONC_USER, "crew")),
        );
        const okCount = results.filter(r => r.ok).length;
        const usedSeries = results.filter(r => r.ok).map(r => r.used).sort((a, b) => a - b);
        const concRow = await usageFor(CONC_USER);
        if (okCount !== 5) {
            fail(`9 simultaneous consumes at limit 5 must grant exactly 5, granted ${okCount}`, results);
        } else if (usedSeries.join(",") !== "1,2,3,4,5") {
            fail("granted concurrent calls must report distinct used values 1..5", usedSeries);
        } else if (concRow?.count !== 5) {
            fail(`stored count should be exactly 5, got ${concRow?.count}`);
        } else pass("9 simultaneous consumes at limit 5 → exactly 5 grants, used 1..5, count=5 (atomic)");

        // ── 6. CREW_AI_DAILY_LIMIT=0 means zero, not "one free" ─────────────
        process.env.CREW_AI_DAILY_LIMIT = "0";
        const ZERO_USER = "crew-zero-ai-quota-smoke";
        await prisma.user.create({ data: { id: ZERO_USER, email: "zero@ai-quota-smoke.invalid", role: "crew" } });
        const zero = await consumeAiCredit(ZERO_USER, "crew");
        const zeroRows = await prisma.aiUsage.count({ where: { userId: ZERO_USER } });
        const zeroOwner = await consumeAiCredit(OWNER, "owner");
        if (zero.ok || zero.limit !== 0 || zero.used !== 0) {
            fail("limit 0 must refuse the very first crew call", zero);
        } else if (zeroRows !== 0) {
            fail(`limit 0 must not write a row (wrote ${zeroRows})`);
        } else if (!zeroOwner.ok) {
            fail("limit 0 must still leave the owner exempt", zeroOwner);
        } else pass("CREW_AI_DAILY_LIMIT=0 refuses the first crew call without writing; owner unaffected");

        // ── 7. The 429 contract P3.6 renders ────────────────────────────────
        const res = aiQuotaExceededResponse({ ok: false, used: 20, limit: 20 });
        const body = await res.json();
        const retryAfter = Number(res.headers.get("Retry-After"));
        if (res.status !== 429) fail(`quota refusal must be 429, got ${res.status}`);
        else if (body.code !== "AI_QUOTA_EXCEEDED") fail("429 body must carry code=AI_QUOTA_EXCEEDED", body);
        else if (body.stage !== "ai-quota") fail("429 body must carry stage=ai-quota", body);
        else if (body.used !== 20 || body.limit !== 20) fail("429 body must carry { used, limit }", body);
        else if (typeof body.error !== "string" || !body.error.includes("20 of 20")) {
            fail("429 body error prose must state 'N of M'", body);
        } else if (!Number.isFinite(retryAfter) || retryAfter < 1 || retryAfter > 86400) {
            fail(`Retry-After should be seconds until UTC midnight, got ${res.headers.get("Retry-After")}`);
        } else pass("429 contract: { error, code, stage, used, limit } + Retry-After (P3.6's shape)");

        // ── 8. The gate is really WIRED into a route, not just importable ───
        // Drives the REAL POST /api/profile/tagline/draft handler through the
        // __seedViewer seam with the limit at 0, so the quota refusal fires
        // before draftTagline() is ever called — no Gemini, no network. This is
        // the assertion that would catch "lib/ai/quota.ts exists and passes its
        // unit tests but nobody calls it", which is the actual failure mode of
        // a seven-route wiring task.
        const { __seedViewer, __resetViewer } = await import("@/lib/viewer");
        try {
            __seedViewer({ id: CREW_A, email: "crew-a@ai-quota-smoke.invalid", role: "crew" });
            const route = await import("@/app/api/profile/tagline/draft/route");
            const routeRes = mustRespond(
                await route.POST(
                    new Request("http://localhost/api/profile/tagline/draft", { method: "POST" }) as never,
                ),
                "tagline/draft POST",
            );
            const routeBody = await routeRes.json();
            if (routeRes.status !== 429) {
                fail(`crew over quota should get 429 from the route, got ${routeRes.status}`, routeBody);
            } else if (routeBody.code !== "AI_QUOTA_EXCEEDED" || routeBody.limit !== 0) {
                fail("route 429 must carry the shared quota contract body", routeBody);
            } else pass("POST /api/profile/tagline/draft: crew over quota → 429 AI_QUOTA_EXCEEDED (wired)");
        } finally {
            __resetViewer();
        }

        // ── 9. Cascade — deleting a user reaps their counters ───────────────
        await prisma.user.delete({ where: { id: CREW_B } });
        const orphans = await prisma.aiUsage.count({ where: { userId: CREW_B } });
        if (orphans !== 0) fail(`AiUsage rows survived their user (${orphans} orphans)`);
        else pass("AiUsage cascades on user delete (no orphaned counters)");
    } finally {
        delete process.env.CREW_AI_DAILY_LIMIT;
        try { await prisma.$disconnect(); } catch { /* best-effort */ }
        for (const suffix of ["", "-journal", "-wal", "-shm"]) {
            try { unlinkSync(TMP_DB + suffix); } catch { /* may not exist */ }
        }
    }

    console.log(`\n${passes}/${passes + fails} steps passed`);
    if (fails > 0) process.exit(1);
    console.log("All checks passed.");
    process.exit(0);
}

main().catch((e) => {
    console.error("smoke crashed:", e);
    process.exit(1);
});
