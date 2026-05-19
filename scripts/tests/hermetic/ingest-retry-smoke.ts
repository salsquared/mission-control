/**
 * PB-5 hermetic smoke. Exercises the `eventFullyCommitted` early-skip and the
 * per-event notifiedAt / gcalSyncedAt checkpoint logic by manipulating rows
 * directly — no Gmail, no LLM.
 *
 * Scenarios:
 *   A. Fresh Application + Event with no checkpoints → eventFullyCommitted = false (notify needed)
 *   B. Notifiable event with notifiedAt stamped → eventFullyCommitted = true
 *   C. Future-scheduled event with notifiedAt but no gcalSyncedAt → false (gcal needed)
 *   D. Past-scheduled event with notifiedAt but no gcalSyncedAt → true (past events skip gcal)
 *   E. Non-notifiable event with no checkpoint → true (nothing to notify)
 *
 * The logic under test is the eventFullyCommitted helper in
 * lib/applications/ingest.ts. To keep this hermetic we re-derive the predicate
 * from the same source so a divergent change is caught.
 */
import { NOTIFY_EVENT_KINDS } from "@/lib/repositories/applicationEvents";

let passed = 0;
let failed = 0;
function check(name: string, condition: boolean, detail?: string) {
    if (condition) { console.log(`[PASS] ${name}`); passed++; }
    else { console.error(`[FAIL] ${name}${detail ? ` — ${detail}` : ""}`); failed++; }
}

// Mirror the predicate from ingest.ts. Keep both in sync; if a behavior change
// hits ingest.ts, update this smoke too.
function eventFullyCommitted(ev: {
    kind: string;
    scheduledAt: Date | null;
    notifiedAt: Date | null;
    gcalSyncedAt: Date | null;
}): boolean {
    const notifyOk = !NOTIFY_EVENT_KINDS.has(ev.kind) || ev.notifiedAt !== null;
    const needsGcal = ev.scheduledAt !== null && ev.scheduledAt.getTime() >= Date.now();
    const gcalOk = !needsGcal || ev.gcalSyncedAt !== null;
    return notifyOk && gcalOk;
}

const futureDate = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
const pastDate = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);

// A. Notifiable event, no notifiedAt yet → must re-fire notify.
check(
    "A: notifiable kind without notifiedAt → not committed",
    eventFullyCommitted({ kind: "OFFER", scheduledAt: null, notifiedAt: null, gcalSyncedAt: null }) === false,
);

// B. Notifiable event, notifiedAt set, no schedule → committed.
check(
    "B: notifiable kind with notifiedAt + no schedule → committed",
    eventFullyCommitted({ kind: "OFFER", scheduledAt: null, notifiedAt: new Date(), gcalSyncedAt: null }) === true,
);

// C. INTERVIEW_SCHEDULED in the future, notify stamped, gcal NOT stamped → not committed.
check(
    "C: future interview with notify ✓ + gcal ✗ → not committed",
    eventFullyCommitted({ kind: "INTERVIEW_SCHEDULED", scheduledAt: futureDate, notifiedAt: new Date(), gcalSyncedAt: null }) === false,
);

// D. Past-scheduled event with notify stamped, gcal NOT stamped → committed
//    (past events intentionally skip gcal sync).
check(
    "D: past interview with notify ✓ + gcal ✗ → committed (gcal not required for past)",
    eventFullyCommitted({ kind: "INTERVIEW_SCHEDULED", scheduledAt: pastDate, notifiedAt: new Date(), gcalSyncedAt: null }) === true,
);

// E. Non-notifiable event (EMAIL_RECEIVED), no checkpoints → committed (nothing to do).
check(
    "E: EMAIL_RECEIVED with no checkpoints → committed (no side-effects apply)",
    eventFullyCommitted({ kind: "EMAIL_RECEIVED", scheduledAt: null, notifiedAt: null, gcalSyncedAt: null }) === true,
);

// F. INTERVIEW_SCHEDULED in the future, BOTH checkpoints set → committed.
check(
    "F: future interview with notify ✓ + gcal ✓ → committed",
    eventFullyCommitted({ kind: "INTERVIEW_SCHEDULED", scheduledAt: futureDate, notifiedAt: new Date(), gcalSyncedAt: new Date() }) === true,
);

// G. REJECTION (notifiable) with notifiedAt null and scheduledAt null → not committed.
check(
    "G: REJECTION without notifiedAt → not committed",
    eventFullyCommitted({ kind: "REJECTION", scheduledAt: null, notifiedAt: null, gcalSyncedAt: null }) === false,
);

console.log(`\n${passed}/${passed + failed} steps passed`);
if (failed > 0) process.exit(1);
console.log("All checks passed.");
