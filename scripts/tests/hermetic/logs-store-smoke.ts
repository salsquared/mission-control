/**
 * Hermetic smoke for the scheduler-log store (docs/archive/scheduler-structured-logs.html).
 *
 * Fully hermetic: no PM2, no network. Uses its OWN temp LOGS_DB_PATH — never
 * touches the real data/logs.db. Cleans up after itself.
 *
 * Scenarios:
 *   1. recordLogLine round-trips a LogEntry into the store (the hot path).
 *   2. since(cursor) returns only rows past the cursor, oldest-first; latestLogId tracks the max id.
 *   3. window(from,to) returns rows within the time window.
 *   4. Per-tier filter — a prod row never shows in a dev read (and vice-versa).
 *   5. Prune drops only rows older than retention; recent rows survive.
 *   6. Disabled store (unwritable path) → empty reads, no throw on record/prune.
 */
import { unlinkSync } from "node:fs";
import type { LogEntry } from "@/lib/logger";

let passed = 0;
let failed = 0;
function check(name: string, condition: boolean, detail?: string) {
    if (condition) {
        console.log(`[PASS] ${name}`);
        passed++;
    } else {
        console.error(`[FAIL] ${name}${detail ? ` — ${detail}` : ""}`);
        failed++;
    }
}

const TMP_DB = `/tmp/logs-store-smoke-${process.pid}-${Date.now()}.db`;
const HOUR = 60 * 60 * 1000;

async function main() {
    // Point the store at a throwaway file BEFORE the first store touch.
    process.env.LOGS_DB_PATH = TMP_DB;

    const store = await import("@/lib/logs-store");
    const {
        recordLogLine,
        readLogsSince,
        readLogsWindow,
        latestLogId,
        pruneLogs,
        _resetLogsStoreForTests,
        _recordForTests,
        _statsForTests,
    } = store;
    await _resetLogsStoreForTests(); // fresh store at TMP_DB

    try {
        const now = Date.now();

        // ---- 1. recordLogLine round-trip (the real hot path) -------------
        // Settle init first so recordLogLine's insert runs synchronously.
        await _statsForTests();
        const entry: LogEntry = {
            id: "x1",
            timestamp: new Date(now - 30 * 60 * 1000).toISOString(),
            level: "info",
            message: "[job-watcher] processed 3 watchlists",
            source: "scheduler",
            tier: "dev",
        };
        recordLogLine(entry);
        await new Promise((r) => setTimeout(r, 20)); // belt-and-suspenders for the queued path
        {
            const rows = await readLogsSince(0, "dev", 100);
            const hit = rows.find((r) => r.msg === entry.message);
            check("recordLogLine: line stored + readable", !!hit, `rows=${rows.length}`);
            check(
                "recordLogLine: source/tier preserved",
                hit?.source === "scheduler" && hit?.tier === "dev",
                JSON.stringify(hit),
            );
        }

        // ---- 2. cursor (since) + latestLogId -----------------------------
        const cursorBefore = await latestLogId();
        await _recordForTests(now - 20 * 60 * 1000, "info", "scheduler", "dev", "line-A");
        await _recordForTests(now - 19 * 60 * 1000, "warn", "scheduler", "dev", "line-B");
        await _recordForTests(now - 18 * 60 * 1000, "error", "scheduler", "dev", "line-C");
        {
            const fresh = await readLogsSince(cursorBefore, "dev", 100);
            check("since: returns exactly the 3 new rows", fresh.length === 3, `len=${fresh.length}`);
            check(
                "since: oldest-first order",
                fresh[0]?.msg === "line-A" && fresh[2]?.msg === "line-C",
                fresh.map((r) => r.msg).join(","),
            );
            const cursorAfter = await latestLogId();
            check("latestLogId: advanced by 3", cursorAfter === cursorBefore + 3, `before=${cursorBefore} after=${cursorAfter}`);
        }

        // ---- 3. window ---------------------------------------------------
        await _recordForTests(now - 10 * HOUR, "info", "scheduler", "dev", "old-window-row");
        {
            const recent = await readLogsWindow(now - HOUR, now, "dev", 1000);
            check(
                "window: [now-1h, now] includes line-A, excludes the 10h-old row",
                recent.some((r) => r.msg === "line-A") && !recent.some((r) => r.msg === "old-window-row"),
                recent.map((r) => r.msg).join(","),
            );
            const wide = await readLogsWindow(now - 11 * HOUR, now, "dev", 1000);
            check("window: wider window includes the 10h-old row", wide.some((r) => r.msg === "old-window-row"));
        }

        // ---- 4. Per-tier filter ------------------------------------------
        await _recordForTests(now - 5 * 60 * 1000, "info", "scheduler", "prod", "prod-only-row");
        {
            const devRows = await readLogsSince(0, "dev", 1000);
            const prodRows = await readLogsSince(0, "prod", 1000);
            check("tier: prod row absent from dev read", !devRows.some((r) => r.msg === "prod-only-row"));
            check("tier: prod row present in prod read", prodRows.some((r) => r.msg === "prod-only-row"));
            check("tier: dev rows absent from prod read", !prodRows.some((r) => r.msg === "line-A"));
        }

        // ---- 5. Prune — drops the >48h row, keeps recent -----------------
        await _recordForTests(now - 50 * HOUR, "info", "scheduler", "dev", "ancient-row");
        {
            const before = await _statsForTests();
            const res = await pruneLogs(); // default 48h retention
            const after = await _statsForTests();
            check("prune: store healthy (not disabled)", res.disabled === false);
            check("prune: deleted exactly the 1 ancient row", res.deleted === 1, `deleted=${res.deleted}`);
            check(
                "prune: recent rows survived",
                !!before && !!after && after.total === before.total - 1,
                `before=${before?.total} after=${after?.total}`,
            );
        }

        await _resetLogsStoreForTests();

        // ---- 6. Disabled store (LAST — unwritable path) ------------------
        {
            process.env.LOGS_DB_PATH = `/nonexistent-logs-dir-${process.pid}/logs.db`;
            await _resetLogsStoreForTests(); // re-init against the bad path → disabled
            let threw = false;
            try {
                recordLogLine({
                    id: "z",
                    timestamp: new Date().toISOString(),
                    level: "info",
                    message: "x",
                    source: "scheduler",
                    tier: "dev",
                });
            } catch {
                threw = true;
            }
            check("disabled: recordLogLine did not throw", !threw);
            const rows = await readLogsSince(0, "dev", 100);
            check("disabled: read returns empty", rows.length === 0);
            const prune = await pruneLogs();
            check("disabled: prune reports disabled", prune.disabled === true && prune.deleted === 0);
            const stats = await _statsForTests();
            check("disabled: stats null", stats === null);
        }

        await _resetLogsStoreForTests();
    } finally {
        for (const suffix of ["", "-wal", "-shm"]) {
            try {
                unlinkSync(TMP_DB + suffix);
            } catch {
                /* may not exist */
            }
        }
    }

    console.log(`\n${passed}/${passed + failed} steps passed`);
    if (failed > 0) process.exit(1);
}

main().catch((e) => {
    console.error("smoke crashed:", e);
    process.exit(1);
});
