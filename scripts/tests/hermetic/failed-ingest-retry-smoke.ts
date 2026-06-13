/**
 * Hermetic smoke for the OQ9b FailedIngest retry queue (P4.3, 2026-06-12):
 *
 *   npx tsx scripts/tests/hermetic/failed-ingest-retry-smoke.ts
 *
 * Asserts:
 *   1. Backoff math — all six delays exact (5m → 20m → 80m → 320m → 1280m →
 *      5120m), strict ×4 ratio, cumulative ≈ 4.7 days (inside Gmail's ~7-day
 *      history window), MAX_ATTEMPTS = 6.
 *   2. Alarm shape — per-attempt warn names "attempt N/6" + the next retry
 *      time; the give-up alarm names Scan Inbox as the manual recovery.
 *   3. Queue flow (throwaway DB + injected ingest stub — no Google auth, no
 *      network): webhook-side recordFailedIngest creates attempts=0 /
 *      nextRetryAt=+5m and on conflict refreshes lastError ONLY; a due row
 *      with a failing ingest gets attempts bumped + rescheduled with backoff
 *      (and the warn fires); not-yet-due rows are not selected; a succeeding
 *      ingest deletes the row; gmail.get 404 drops the row; the 6th failure
 *      gives up (Scan Inbox warn, row kept) and is NEVER selected again (no
 *      7th schedule); 30d prune; rows retry under their own userId
 *      (multi-user correctness); clearFailedIngest removes a queued row.
 *
 * Genuinely hermetic: DB is a THROWAWAY SQLite file in /tmp (DATABASE_URL
 * pinned before any import; DDL matches migration 20260613001243_add_failed_ingest).
 * dev.db / prod.db are never touched. No network, no PM2.
 */
const TMP_DB = `/tmp/failed-ingest-retry-smoke-${process.pid}-${Date.now()}.db`;
process.env.DATABASE_URL = `file:${TMP_DB}`;
process.env.EMAIL_ENABLED = "0";

import { unlinkSync } from "node:fs";

let passes = 0;
let fails = 0;
function pass(msg: string) { console.log(`[PASS] ${msg}`); passes++; }
function fail(msg: string, detail?: unknown) { console.error(`[FAIL] ${msg}`, detail ?? ""); fails++; }

const MIN = 60 * 1000;

const DDL = [
    `CREATE TABLE "User" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "name" TEXT,
        "email" TEXT,
        "emailVerified" DATETIME,
        "image" TEXT,
        "lastSyncedHistoryId" TEXT
    )`,
    `CREATE UNIQUE INDEX "User_email_key" ON "User"("email")`,
    `CREATE TABLE "FailedIngest" (
        "msgId" TEXT NOT NULL PRIMARY KEY,
        "userId" TEXT NOT NULL,
        "firstFailedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "attempts" INTEGER NOT NULL DEFAULT 0,
        "lastError" TEXT NOT NULL,
        "nextRetryAt" DATETIME NOT NULL,
        CONSTRAINT "FailedIngest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
    )`,
    `CREATE INDEX "FailedIngest_nextRetryAt_idx" ON "FailedIngest"("nextRetryAt")`,
];

/** Collect console.warn lines emitted while fn runs (alarms are warns). */
async function captureWarns<T>(fn: () => Promise<T>): Promise<{ result: T; warns: string[] }> {
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
    try {
        const result = await fn();
        return { result, warns };
    } finally {
        console.warn = orig;
    }
}

async function main() {
    // ── 1. Backoff math (pure — no DB needed) ───────────────────────────────
    const {
        retryDelayMs, MAX_ATTEMPTS, BACKOFF_FACTOR, FIRST_RETRY_DELAY_MS,
        formatRetryAlarm, formatGiveUpAlarm, truncateError,
        recordFailedIngest, clearFailedIngest,
    } = await import("@/lib/applications/failed-ingest");

    const expectedDelaysMin = [5, 20, 80, 320, 1280, 5120];
    const actualDelaysMin = expectedDelaysMin.map((_, i) => retryDelayMs(i) / MIN);
    if (actualDelaysMin.some((d, i) => d !== expectedDelaysMin[i])) {
        fail(`backoff delays wrong: got [${actualDelaysMin}] expected [${expectedDelaysMin}]`);
    } else pass(`all six delays exact: ${expectedDelaysMin.join("m, ")}m (5m → 20m → ~1.3h → ~5.3h → ~21h → ~3.6d)`);

    let ratioOk = true;
    for (let i = 0; i < 5; i++) {
        if (retryDelayMs(i + 1) / retryDelayMs(i) !== BACKOFF_FACTOR) ratioOk = false;
    }
    if (!ratioOk || BACKOFF_FACTOR !== 4) fail("backoff is not strictly ×4");
    else pass("strict ×4 ratio between consecutive delays");

    const cumulativeDays = expectedDelaysMin.reduce((a, b) => a + b, 0) / (24 * 60);
    if (cumulativeDays >= 7 || cumulativeDays < 4) {
        fail(`cumulative backoff ${cumulativeDays.toFixed(2)}d should be ≈4.7d, inside Gmail's ~7d window`);
    } else pass(`cumulative backoff ≈ ${cumulativeDays.toFixed(2)} days — inside Gmail's ~7d history window`);

    if (MAX_ATTEMPTS !== 6) fail(`MAX_ATTEMPTS should be 6, got ${MAX_ATTEMPTS}`);
    else pass("attempt cap is 6 (≤7 parse calls ever: 1 webhook + 6 queue)");

    if (FIRST_RETRY_DELAY_MS !== 5 * MIN || retryDelayMs(0) !== 5 * MIN) {
        fail("first retry delay must be 5 minutes");
    } else pass("first retry delay is 5 minutes (matches the job's 5-min interval)");

    // ── 2. Alarm shape (pure) ───────────────────────────────────────────────
    const nextRetryAt = new Date("2026-06-13T14:05:00.000Z");
    const alarm = formatRetryAlarm({ msgId: "msg-a", attempts: 3, nextRetryAt, lastError: "classifier failed: boom" });
    if (!alarm.includes("attempt 3/6")) fail("retry alarm must name attempt N/6", alarm);
    else if (!alarm.includes(nextRetryAt.toISOString())) fail("retry alarm must name the next retry time", alarm);
    else if (!alarm.includes("classifier failed: boom")) fail("retry alarm must carry the last error", alarm);
    else pass("per-attempt alarm names attempt 3/6 + next retry time + last error");

    const giveUp = formatGiveUpAlarm({ msgId: "msg-a", lastError: "boom" });
    if (!giveUp.includes("Scan Inbox")) fail("give-up alarm must name Scan Inbox as the manual recovery", giveUp);
    else if (!giveUp.includes("6/6")) fail("give-up alarm must name the exhausted attempt count", giveUp);
    else pass("give-up alarm names Scan Inbox + 6/6 attempts");

    const longErr = "x".repeat(900);
    if (truncateError(longErr).length > 501) fail("lastError should be capped at ~500 chars");
    else pass("error strings capped before storage");

    // ── 3. Queue flow against a throwaway DB ────────────────────────────────
    const { prisma } = await import("@/lib/prisma");
    for (const ddl of DDL) await prisma.$executeRawUnsafe(ddl);
    const { runFailedIngestRetry } = await import("@/scheduler/jobs/failed-ingest-retry");
    type Outcome = Awaited<ReturnType<typeof import("@/lib/applications/ingest").ingestGmailMessage>>;

    const USER_A = "user-a-failed-ingest-smoke";
    const USER_B = "user-b-failed-ingest-smoke";

    try {
        await prisma.user.create({ data: { id: USER_A, email: "a@failed-ingest-smoke.invalid" } });
        await prisma.user.create({ data: { id: USER_B, email: "b@failed-ingest-smoke.invalid" } });

        // Webhook producer: create → attempts 0, nextRetryAt = +5m.
        const t0 = new Date("2026-06-13T10:00:00.000Z");
        await recordFailedIngest({ msgId: "m-flow", userId: USER_A, error: "classifier failed: first", now: t0 });
        const created = await prisma.failedIngest.findUnique({ where: { msgId: "m-flow" } });
        if (!created || created.attempts !== 0) fail("recordFailedIngest should create with attempts 0", created);
        else if (created.nextRetryAt.getTime() !== t0.getTime() + 5 * MIN) {
            fail("recordFailedIngest should schedule the first retry at +5m", created);
        } else pass("webhook create: attempts=0, nextRetryAt=+5m, firstFailedAt stamped");

        // Webhook conflict (re-walk re-fails): lastError refreshed ONLY.
        await recordFailedIngest({ msgId: "m-flow", userId: USER_A, error: "classifier failed: second", now: new Date(t0.getTime() + MIN) });
        const refreshed = await prisma.failedIngest.findUnique({ where: { msgId: "m-flow" } });
        if (refreshed?.attempts !== 0
            || refreshed.nextRetryAt.getTime() !== created!.nextRetryAt.getTime()
            || refreshed.firstFailedAt.getTime() !== created!.firstFailedAt.getTime()
            || refreshed.lastError !== "classifier failed: second") {
            fail("webhook conflict must refresh lastError only (no attempts bump, no reschedule)", refreshed);
        } else pass("webhook conflict: lastError refreshed, attempts/schedule untouched (queue owns the schedule)");

        // Due row + failing ingest → attempts bumped + rescheduled with backoff.
        const t1 = new Date(t0.getTime() + 6 * MIN); // past nextRetryAt
        const failing = async (): Promise<Outcome> => ({ action: "errored", reason: "classifier failed: still down" });
        const { result: r1, warns: w1 } = await captureWarns(() =>
            runFailedIngestRetry({ ingestOne: failing, now: () => t1 }));
        const afterFail = await prisma.failedIngest.findUnique({ where: { msgId: "m-flow" } });
        if (r1.due !== 1 || r1.rescheduled !== 1) fail("one due row should fail → rescheduled", r1);
        else if (afterFail?.attempts !== 1) fail("failed attempt should bump attempts to 1", afterFail);
        else if (afterFail.nextRetryAt.getTime() !== t1.getTime() + 20 * MIN) {
            fail("reschedule should be +20m (5m × 4^1)", afterFail);
        } else if (!w1.some((w) => w.includes("attempt 1/6") && w.includes(afterFail.nextRetryAt.toISOString()))) {
            fail("per-attempt alarm warn (attempt 1/6 + next retry time) must fire", w1);
        } else pass("due row + failing ingest → attempts=1, rescheduled +20m, alarm warn fired");

        // Not due yet → not selected.
        const r2 = await runFailedIngestRetry({
            ingestOne: async () => { throw new Error("must not be called — row not due"); },
            now: () => new Date(t1.getTime() + MIN),
        });
        if (r2.due !== 0) fail("row rescheduled into the future must not be selected", r2);
        else pass("not-yet-due row is not selected");

        // Succeeding ingest (incl. skipped: duplicate) → row deleted.
        const t2 = new Date(t1.getTime() + 21 * MIN);
        const r3 = await runFailedIngestRetry({
            ingestOne: async () => ({ action: "skipped", reason: "duplicate" }) as Outcome,
            now: () => t2,
        });
        if (r3.due !== 1 || r3.succeeded !== 1) fail("due row + succeeding ingest should count as recovered", r3);
        else if (await prisma.failedIngest.findUnique({ where: { msgId: "m-flow" } }) !== null) {
            fail("recovered row must be deleted");
        } else pass("succeeding ingest (skipped: duplicate) → row deleted");

        // gmail.get 404 → row dropped.
        await recordFailedIngest({ msgId: "m-404", userId: USER_A, error: "gmail.get failed: gone", now: t0 });
        const r4 = await runFailedIngestRetry({
            ingestOne: async () => ({ action: "errored", reason: "gmail.get failed: Requested entity was not found.", gmailStatus: 404 }) as Outcome,
            now: () => t1,
        });
        if (r4.dropped404 !== 1 || await prisma.failedIngest.findUnique({ where: { msgId: "m-404" } }) !== null) {
            fail("gmail.get 404 should drop the row", r4);
        } else pass("gmail.get 404 (email deleted) → row dropped");

        // Cap: 6th failure → give-up alarm, row kept, never selected again.
        await prisma.failedIngest.create({
            data: { msgId: "m-cap", userId: USER_A, firstFailedAt: t0, attempts: 5, lastError: "old", nextRetryAt: t0 },
        });
        const { result: r5, warns: w5 } = await captureWarns(() =>
            runFailedIngestRetry({ ingestOne: failing, now: () => t1 }));
        const capped = await prisma.failedIngest.findUnique({ where: { msgId: "m-cap" } });
        if (r5.gaveUp !== 1 || capped?.attempts !== 6) fail("6th failure should give up with attempts=6", { r5, capped });
        else if (!w5.some((w) => w.includes("Scan Inbox") && w.includes("m-cap"))) {
            fail("give-up alarm naming Scan Inbox must fire", w5);
        } else pass("6th failed attempt → give-up alarm (Scan Inbox), row kept as inventory");

        // Even when due by time, a capped row is never re-selected (no 7th schedule).
        await prisma.failedIngest.update({ where: { msgId: "m-cap" }, data: { nextRetryAt: t0 } });
        const r6 = await runFailedIngestRetry({
            ingestOne: async () => { throw new Error("must not be called — row is capped"); },
            now: () => new Date(t1.getTime() + 365 * 24 * 60 * MIN),
        });
        if (r6.due !== 0) fail("capped row (attempts=6) must never be selected again", r6);
        else pass("capped row never re-selected — no 7th schedule (≤7 parse budget holds)");
        // (that far-future run also pruned m-cap via the 30d sweep — covered next)
        if (r6.pruned !== 1) fail("far-future tick should have pruned the >30d-old capped row", r6);
        else pass("30d prune removes aged rows (same policy as WebhookDelivery)");

        // Multi-user: each row retried under its own userId.
        await prisma.failedIngest.create({
            data: { msgId: "m-user-a", userId: USER_A, firstFailedAt: t1, attempts: 0, lastError: "e", nextRetryAt: t0 },
        });
        await prisma.failedIngest.create({
            data: { msgId: "m-user-b", userId: USER_B, firstFailedAt: t1, attempts: 0, lastError: "e", nextRetryAt: t0 },
        });
        const calls: Array<{ msgId: string; userId: string }> = [];
        await runFailedIngestRetry({
            ingestOne: async (row) => { calls.push(row); return { action: "updated", appId: "app-x" } as Outcome; },
            now: () => t1,
        });
        const aCall = calls.find((c) => c.msgId === "m-user-a");
        const bCall = calls.find((c) => c.msgId === "m-user-b");
        if (calls.length !== 2 || aCall?.userId !== USER_A || bCall?.userId !== USER_B) {
            fail("each row must be retried under its own userId", calls);
        } else pass("multi-user: each row retried under its own userId");

        // clearFailedIngest (webhook re-walk success path).
        await recordFailedIngest({ msgId: "m-clear", userId: USER_A, error: "e", now: t1 });
        await clearFailedIngest("m-clear");
        if (await prisma.failedIngest.findUnique({ where: { msgId: "m-clear" } }) !== null) {
            fail("clearFailedIngest should remove the queued row");
        } else pass("clearFailedIngest removes the queued row (webhook re-walk success)");
    } finally {
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
