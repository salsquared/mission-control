/**
 * Hermetic regression for Bug G (commit 86f5aec) — broadcastEvent used a
 * bare for-of with a direct listener call. A throwing listener (typically
 * an SSE client whose underlying socket closed between subscribe and the
 * next write) aborted the loop and skipped every listener inserted after
 * it. One dead client could blackhole live updates for all other clients.
 *
 * Fix: each listener call wrapped in try/catch + warn-log. Iteration
 * continues regardless.
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

async function main() {
    // Suppress the warn that broadcastEvent emits when a listener throws —
    // it's expected by this test and would just clutter the output.
    const origWarn = console.warn;
    console.warn = () => {};

    // Three listeners, subscribed in this order:
    //   1. Healthy — should receive every event regardless of order.
    //   2. Throwing — simulates a dead SSE client whose controller.enqueue
    //      threw because the underlying socket closed. Pre-fix, this would
    //      abort the for-of and skip listener #3.
    //   3. Healthy — would silently miss broadcasts pre-fix.
    const received1: ServerEvent[] = [];
    const received3: ServerEvent[] = [];
    let throwCount = 0;

    const unsub1 = subscribeToEvents(ev => received1.push(ev));
    const unsub2 = subscribeToEvents(() => {
        throwCount++;
        throw new Error("simulated SSE write to closed controller");
    });
    const unsub3 = subscribeToEvents(ev => received3.push(ev));

    try {
        const event: ServerEvent = { model: "Application", action: "upsert", id: "test-1", timestamp: Date.now() };
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
