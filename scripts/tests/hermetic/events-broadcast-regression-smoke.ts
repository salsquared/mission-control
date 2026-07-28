/**
 * Two regressions on `lib/events.ts`, in one file because they interact — the
 * per-user filter added by the second runs inside the loop the first one
 * hardened, so a naive `continue`/`try` mistake breaks exactly one of them.
 *
 * PART 1 — Bug G (commit 86f5aec). broadcastEvent used a bare for-of with a
 * direct listener call. A throwing listener (typically an SSE client whose
 * underlying socket closed between subscribe and the next write) aborted the
 * loop and skipped every listener inserted after it. One dead client could
 * blackhole live updates for all other clients.
 *   Fix: each listener call wrapped in try/catch + warn-log. Iteration
 *   continues regardless.
 *
 * PART 2 — cross-user leak (P2.4, docs/multi-user-crew.html §2.8). Before the
 * owner/crew work `ServerEvent` had no user scope and every subscriber got the
 * whole firehose, so crew received the owner's row-change events and each
 * other's. Fix: `ServerEvent` is a discriminated union — `UserServerEvent`
 * carries a required `userId` and is delivered ONLY to the subscriber whose
 * viewer id matches, while `GlobalServerEvent` (`Cache`, `FinanceTick`) still
 * fans out to everyone.
 *
 *   DATABASE_URL="file:./dev.db" npx tsx scripts/tests/hermetic/events-broadcast-regression-smoke.ts
 *
 * Pure unit test — no DB, no network. Kept in hermetic/ so pre-push runs it.
 */
import { broadcastEvent, subscribeToEvents, type ServerEvent } from "@/lib/events";

let passes = 0;
let fails = 0;
function pass(msg: string) { console.log(`[PASS] ${msg}`); passes++; }
function fail(msg: string, detail?: unknown) { console.error(`[FAIL] ${msg}`, detail ?? ""); fails++; }

const VIEWER = "user-bugg";

function bugGRegression() {
    console.log("\n-- Part 1: Bug G — a throwing listener must not blackhole the rest --");

    // Three listeners, subscribed in this order:
    //   1. Healthy — should receive every event regardless of order.
    //   2. Throwing — simulates a dead SSE client whose controller.enqueue
    //      threw because the underlying socket closed. Pre-fix, this would
    //      abort the for-of and skip listener #3.
    //   3. Healthy — would silently miss broadcasts pre-fix.
    // All three share one viewer id so the P2.4 scope filter admits all of
    // them and this part still tests only the try/catch.
    const received1: ServerEvent[] = [];
    const received3: ServerEvent[] = [];
    let throwCount = 0;

    const unsub1 = subscribeToEvents(VIEWER, ev => received1.push(ev));
    const unsub2 = subscribeToEvents(VIEWER, () => {
        throwCount++;
        throw new Error("simulated SSE write to closed controller");
    });
    const unsub3 = subscribeToEvents(VIEWER, ev => received3.push(ev));

    try {
        const event: ServerEvent = { model: "Application", action: "upsert", id: "test-1", userId: VIEWER, timestamp: Date.now() };
        broadcastEvent(event);
        broadcastEvent({ ...event, id: "test-2" });
        broadcastEvent({ ...event, id: "test-3" });

        if (received1.length !== 3) {
            fail(`listener-1 (healthy, before throw) got ${received1.length} events, expected 3`);
        } else {
            pass("listener-1 (healthy) received all 3 events");
        }
        if (throwCount !== 3) {
            fail(`listener-2 (throwing) was called ${throwCount} times, expected 3 (the test's premise)`);
        } else {
            pass("listener-2 (throwing) was invoked 3 times");
        }
        if (received3.length !== 3) {
            fail(`listener-3 (healthy, AFTER throw) got ${received3.length} events, expected 3 — Bug G regressed (one dead listener blackholed the rest)`);
        } else {
            pass("listener-3 (healthy, subscribed after the throwing one) still received all 3 events");
        }
    } finally {
        unsub1();
        unsub2();
        unsub3();
    }
}

function crossUserIsolation() {
    console.log("\n-- Part 2: per-user fan-out — a user event reaches only its owner --");

    const ALICE = "user-alice";
    const BOB = "user-bob";

    const toAlice: ServerEvent[] = [];
    const toBob: ServerEvent[] = [];

    const unsubA = subscribeToEvents(ALICE, ev => toAlice.push(ev));
    const unsubB = subscribeToEvents(BOB, ev => toBob.push(ev));

    try {
        // One user-scoped event per viewer, then one global.
        broadcastEvent({ model: "Application", action: "upsert", id: "app-a", userId: ALICE, timestamp: Date.now() });
        broadcastEvent({ model: "Notification", action: "upsert", userId: BOB, timestamp: Date.now() });
        broadcastEvent({ model: "Cache", action: "invalidate", id: "/api/space*", timestamp: Date.now() });

        // Alice: her Application + the global Cache. Never Bob's Notification.
        const aliceModels = toAlice.map(e => e.model).sort();
        if (aliceModels.join(",") !== "Application,Cache") {
            fail(`alice received [${aliceModels.join(", ")}], expected [Application, Cache] — cross-user leak or a dropped global`, toAlice);
        } else {
            pass("alice received exactly her own Application event + the global Cache event");
        }
        if (toAlice.some(e => e.model === "Notification")) {
            fail("alice received BOB's Notification event — the per-user filter leaked");
        } else {
            pass("alice did NOT receive bob's Notification event");
        }

        // Bob: mirror image.
        const bobModels = toBob.map(e => e.model).sort();
        if (bobModels.join(",") !== "Cache,Notification") {
            fail(`bob received [${bobModels.join(", ")}], expected [Cache, Notification] — cross-user leak or a dropped global`, toBob);
        } else {
            pass("bob received exactly his own Notification event + the global Cache event");
        }
        if (toBob.some(e => e.model === "Application")) {
            fail("bob received ALICE's Application event — the per-user filter leaked");
        } else {
            pass("bob did NOT receive alice's Application event");
        }

        // The global arm explicitly: both, not just one.
        const aliceGlobals = toAlice.filter(e => e.model === "Cache").length;
        const bobGlobals = toBob.filter(e => e.model === "Cache").length;
        if (aliceGlobals !== 1 || bobGlobals !== 1) {
            fail(`global Cache event reached alice ${aliceGlobals}× and bob ${bobGlobals}×, expected 1× each — GlobalServerEvent must fan out to every subscriber`);
        } else {
            pass("the global Cache event reached BOTH subscribers");
        }

        // An event for a viewer with no subscriber must simply go nowhere —
        // not fall back to a broadcast.
        const beforeA = toAlice.length;
        const beforeB = toBob.length;
        broadcastEvent({ model: "Task", action: "upsert", id: "t-1", userId: "user-nobody", timestamp: Date.now() });
        if (toAlice.length !== beforeA || toBob.length !== beforeB) {
            fail("an event scoped to an unsubscribed viewer was delivered to someone else");
        } else {
            pass("an event for a viewer with no subscriber was delivered to nobody");
        }
    } finally {
        unsubA();
        unsubB();
    }
}

async function main() {
    // Suppress the warn that broadcastEvent emits when a listener throws —
    // it's expected by this test and would just clutter the output.
    const origWarn = console.warn;
    console.warn = () => {};

    try {
        bugGRegression();
        crossUserIsolation();
    } finally {
        console.warn = origWarn;
        console.log(`\n${passes}/${passes + fails} steps passed`);
        if (fails === 0) console.log("All checks passed.");
    }
    if (fails > 0) process.exit(1);
}

main().catch((e) => {
    console.error("Unhandled error:", e);
    process.exit(1);
});
