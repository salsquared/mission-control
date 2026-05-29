/**
 * C4 webhook 404-recovery hermetic smoke (docs/gmail-realtime-push.html §3 C4).
 * No HTTP, no Gmail. Two parts:
 *
 *   A. isStaleHistoryError() correctly classifies the stale-history 404 across
 *      the shapes googleapis throws (.code / .status / .response.status; number
 *      or string) and does NOT swallow other errors (403 / 429 / 500 / plain
 *      Error / null / string) — those must still 500.
 *   B. Source-grep guards that app/api/gmail/webhook/route.ts actually wires the
 *      recovery: imports the helper, gates on it, re-seeds lastSyncedHistoryId
 *      from the envelope, acks 200 with `reseeded`, and rethrows everything else.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isStaleHistoryError } from "@/lib/gmail/history-errors";

let passed = 0, failed = 0;
function check(name: string, cond: boolean, detail?: string) {
    if (cond) { console.log(`[PASS] ${name}`); passed++; }
    else { console.error(`[FAIL] ${name}${detail ? ` — ${detail}` : ""}`); failed++; }
}

// ── Part A: classifier truth table ──
check("code 404 (number) is stale-history", isStaleHistoryError({ code: 404 }));
check("code '404' (string) is stale-history", isStaleHistoryError({ code: "404" }));
check("status 404 is stale-history", isStaleHistoryError({ status: 404 }));
check("response.status 404 (GaxiosError) is stale-history", isStaleHistoryError({ response: { status: 404 } }));
check("code 403 is NOT stale-history", !isStaleHistoryError({ code: 403 }));
check("code 429 is NOT stale-history", !isStaleHistoryError({ code: 429 }));
check("response.status 500 is NOT stale-history", !isStaleHistoryError({ response: { status: 500 } }));
check("plain Error is NOT stale-history", !isStaleHistoryError(new Error("network")));
check("null is NOT stale-history", !isStaleHistoryError(null));
check("undefined is NOT stale-history", !isStaleHistoryError(undefined));
check("bare string is NOT stale-history", !isStaleHistoryError("404"));

// ── Part B: route wiring ──
const routeSrc = readFileSync(join(process.cwd(), "app/api/gmail/webhook/route.ts"), "utf-8");
check(
    "route imports isStaleHistoryError from lib/gmail/history-errors",
    /import\s+\{[^}]*isStaleHistoryError[^}]*\}\s+from\s+["']@\/lib\/gmail\/history-errors["']/.test(routeSrc),
);
check("route gates recovery on isStaleHistoryError(...)", /isStaleHistoryError\s*\(/.test(routeSrc));
check("route re-seeds lastSyncedHistoryId from the envelope", /lastSyncedHistoryId:\s*envelopeHistoryId/.test(routeSrc));
check("route acks 200 with reseeded flag", /reseeded:\s*true/.test(routeSrc));
check("route rethrows non-404 history errors", /throw\s+histErr/.test(routeSrc));

console.log(`\n${passed}/${passed + failed} checks passed`);
if (failed > 0) process.exit(1);
console.log("All checks passed.");
