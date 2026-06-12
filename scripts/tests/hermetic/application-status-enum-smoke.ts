/**
 * Hermetic smoke for the CLOSED application status (2026-06-09, closed-jobs
 * feature foundation — Step 0 / P2.1.1).
 *
 * Pins three invariants the rest of the feature builds on:
 *   1. CLOSED is a member of APPLICATION_STATUSES (the kanban renders columns
 *      off this list; the cascade writes status="CLOSED").
 *   2. ApplicationStatusSchema accepts "CLOSED" and still rejects garbage —
 *      the POST/PATCH routes validate through it.
 *   3. The pre-existing statuses are all still present and CLOSED sits AFTER
 *      REJECTED (terminal placement, OQ2), so a careless reorder is caught.
 *
 *   npx tsx scripts/tests/hermetic/application-status-enum-smoke.ts
 *
 * Pure — no DB, no Prisma, no env needed.
 */
import { APPLICATION_STATUSES, ApplicationStatusSchema } from "@/lib/schemas/applications";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean) {
    if (cond) { console.log(`[PASS] ${name}`); passed++; }
    else { console.error(`[FAIL] ${name}`); failed++; }
}

// 1. Membership
ok("APPLICATION_STATUSES includes CLOSED", (APPLICATION_STATUSES as readonly string[]).includes("CLOSED"));

// 2. Schema accepts CLOSED, rejects unknown
ok("ApplicationStatusSchema accepts 'CLOSED'", ApplicationStatusSchema.safeParse("CLOSED").success);
ok("ApplicationStatusSchema rejects 'NOT_A_STATUS'", !ApplicationStatusSchema.safeParse("NOT_A_STATUS").success);
ok("ApplicationStatusSchema rejects '' (empty)", !ApplicationStatusSchema.safeParse("").success);

// 3. Regression: every prior status survives + terminal ordering
const REQUIRED_PRIOR = [
    "INTERESTED", "APPLIED", "UPDATED", "ASSESSMENT", "INTERVIEW_REQUESTED",
    "INTERVIEW", "OFFER", "ACCEPTED", "DECLINED", "REJECTED",
];
for (const s of REQUIRED_PRIOR) {
    ok(`prior status still present: ${s}`, (APPLICATION_STATUSES as readonly string[]).includes(s));
}
const idxRejected = (APPLICATION_STATUSES as readonly string[]).indexOf("REJECTED");
const idxClosed = (APPLICATION_STATUSES as readonly string[]).indexOf("CLOSED");
ok("CLOSED sits after REJECTED (terminal placement)", idxRejected >= 0 && idxClosed > idxRejected);
ok("CLOSED is the last status", idxClosed === APPLICATION_STATUSES.length - 1);

console.log(`\n${passed}/${passed + failed} steps passed`);
if (failed > 0) process.exit(1);
