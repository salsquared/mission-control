/**
 * Hermetic smoke for the fetcher-health store (docs/fetcher-health-store.html).
 *
 * Fully hermetic: no PM2, no network (the loggedFetch check stubs global fetch),
 * and it uses its OWN temp FETCHER_HEALTH_PATH — never touches the real
 * data/fetcher-health.db. Cleans up after itself.
 *
 * Scenarios:
 *   1. Per-host counts across all four buckets (ok/error/fallback/broken).
 *   2. Window totals (1h ⊆ 6h ⊆ 1d) + window-driven per-host map.
 *   3. Per-tier filter — a dev row never shows in a prod read.
 *   4. Per-source filter — web vs scheduler scoping.
 *   5. loggedFetch maps a 500 → error and a 200 → ok (the OQ2 contract).
 *   6. Prune drops only rows older than retention; recent rows survive.
 *   7. Disabled store (unwritable path) → empty reads, no throw on record/prune.
 */
import { unlinkSync } from "node:fs";

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

const TMP_DB = `/tmp/fetcher-health-smoke-${process.pid}-${Date.now()}.db`;
const HOUR = 60 * 60 * 1000;

async function main() {
    // Point the store at a throwaway file BEFORE the first store touch.
    process.env.FETCHER_HEALTH_PATH = TMP_DB;
    delete process.env.MC_SCHEDULER_TIER; // deterministic: web-process semantics

    const store = await import("@/lib/fetcher-health/store");
    const {
        readFetcherHealth,
        pruneFetcherHealth,
        recordFetchOutcome,
        currentTier,
        _resetFetcherHealthForTests,
        _recordForTests,
        _statsForTests,
    } = store;
    await _resetFetcherHealthForTests(); // fresh store at TMP_DB

    try {
        const now = Date.now();

        // ---- Seed events across buckets / windows / tiers / sources --------
        // hostA (dev/web): 3 ok + 1 error in last 1h; +1 ok in the 1h–6h band.
        await _recordForTests(now - 10 * 60 * 1000, "hostA", "ok", "dev", "web");
        await _recordForTests(now - 11 * 60 * 1000, "hostA", "ok", "dev", "web");
        await _recordForTests(now - 12 * 60 * 1000, "hostA", "ok", "dev", "web");
        await _recordForTests(now - 13 * 60 * 1000, "hostA", "error", "dev", "web");
        await _recordForTests(now - 3 * HOUR, "hostA", "ok", "dev", "web"); // 1h–6h band
        // hostB (dev/web): 1 broken + 1 fallback in last 1h.
        await _recordForTests(now - 20 * 60 * 1000, "hostB", "broken", "dev", "web");
        await _recordForTests(now - 21 * 60 * 1000, "hostB", "fallback", "dev", "web");
        // hostC (PROD/web): 5 ok in last 1h — must NOT appear in a dev read.
        for (let i = 0; i < 5; i++) await _recordForTests(now - 5 * 60 * 1000, "hostC", "ok", "prod", "web");
        // hostD (dev/SCHEDULER): 2 ok in last 1h.
        await _recordForTests(now - 6 * 60 * 1000, "hostD", "ok", "dev", "scheduler");
        await _recordForTests(now - 7 * 60 * 1000, "hostD", "ok", "dev", "scheduler");
        // An ancient dev/web row (>48h) for the prune scenario.
        await _recordForTests(now - 50 * HOUR, "hostA", "ok", "dev", "web");

        // ---- 1 + 2. dev / all / 1h ----------------------------------------
        {
            const { health, totals } = await readFetcherHealth(now, "dev", undefined, "1h");
            check("1h: hostA ok=3", health["hostA"]?.ok === 3, `ok=${health["hostA"]?.ok}`);
            check("1h: hostA error=1", health["hostA"]?.error === 1, `error=${health["hostA"]?.error}`);
            check("1h: hostB broken=1 fallback=1",
                health["hostB"]?.broken === 1 && health["hostB"]?.fallback === 1,
                JSON.stringify(health["hostB"]));
            check("1h: hostD (scheduler) included under source=all", health["hostD"]?.ok === 2, `ok=${health["hostD"]?.ok}`);
            check("1h: hostC (prod) absent from dev read", !health["hostC"]);
            check("1h: ancient hostA row excluded from 1d window", health["hostA"]?.ok === 3); // not 4
            check("1h: totals.ok = 5 (3 hostA + 2 hostD)", totals["1h"].ok === 5, `ok=${totals["1h"].ok}`);
            check("1h: totals.error/broken/fallback = 1 each",
                totals["1h"].error === 1 && totals["1h"].broken === 1 && totals["1h"].fallback === 1,
                JSON.stringify(totals["1h"]));
        }

        // ---- 2. window-driven per-host map (6h shows the banded row) -------
        {
            const { health, totals } = await readFetcherHealth(now, "dev", undefined, "6h");
            check("6h: hostA ok=4 (includes the 1h–6h band row)", health["hostA"]?.ok === 4, `ok=${health["hostA"]?.ok}`);
            check("6h: totals.ok = 6", totals["6h"].ok === 6, `ok=${totals["6h"].ok}`);
            check("1d totals == 6h totals (no rows in 6h–24h)", totals["1d"].ok === 6, `ok=${totals["1d"].ok}`);
        }

        // ---- 3. Per-tier filter -------------------------------------------
        {
            const { health } = await readFetcherHealth(now, "prod", undefined, "1d");
            check("prod read: hostC present (ok=5)", health["hostC"]?.ok === 5, `ok=${health["hostC"]?.ok}`);
            check("prod read: dev hosts absent", !health["hostA"] && !health["hostB"] && !health["hostD"]);
        }

        // ---- 4. Per-source filter -----------------------------------------
        {
            const web = await readFetcherHealth(now, "dev", "web", "1h");
            check("source=web: hostA present, hostD (scheduler) absent",
                !!web.health["hostA"] && !web.health["hostD"]);
            const sched = await readFetcherHealth(now, "dev", "scheduler", "1h");
            check("source=scheduler: hostD present, hostA absent",
                !!sched.health["hostD"] && !sched.health["hostA"]);
        }

        // ---- 5. loggedFetch outcome mapping (OQ2) + host:port — stub fetch -
        {
            const origFetch = globalThis.fetch;
            const { loggedFetch } = await import("@/lib/external-fetch");
            try {
                globalThis.fetch = (async () => new Response(null, { status: 500 })) as typeof fetch;
                await loggedFetch("https://err.smoke.example-host.io/x");
                globalThis.fetch = (async () => new Response(null, { status: 200 })) as typeof fetch;
                await loggedFetch("https://ok.smoke.example-host.io/x");
                // A local fetch IS counted, keyed by host:port (non-default port).
                await loggedFetch("http://localhost:7777/x");
                // record:false defers the outcome to the caller (scraper paths) —
                // loggedFetch itself records nothing, so no ok+broken double-count.
                await loggedFetch("https://norecord.smoke.io/x", undefined, { record: false });
            } finally {
                globalThis.fetch = origFetch;
            }
            const { health } = await readFetcherHealth(Date.now(), currentTier(), undefined, "1h");
            check("loggedFetch: 500 → error", health["err.smoke.example-host.io"]?.error === 1, JSON.stringify(health["err.smoke.example-host.io"]));
            check("loggedFetch: 200 → ok (standard port → no :443 suffix)", health["ok.smoke.example-host.io"]?.ok === 1, JSON.stringify(health["ok.smoke.example-host.io"]));
            check("loggedFetch: local fetch counted as host:port", health["localhost:7777"]?.ok === 1, JSON.stringify(health["localhost:7777"]));
            check("loggedFetch: record:false records nothing", !health["norecord.smoke.io"], JSON.stringify(health["norecord.smoke.io"]));
        }

        // ---- 6. Prune — drops the >48h row, keeps recent ------------------
        {
            const before = await _statsForTests();
            const res = await pruneFetcherHealth(); // default 48h retention
            const after = await _statsForTests();
            check("prune: store healthy (not disabled)", res.disabled === false);
            check("prune: deleted exactly the 1 ancient row", res.deleted === 1, `deleted=${res.deleted}`);
            check("prune: recent rows survived",
                !!before && !!after && after.total === before.total - 1,
                `before=${before?.total} after=${after?.total}`);
        }

        // ---- 7. Disabled store (LAST — unwritable path) -------------------
        {
            process.env.FETCHER_HEALTH_PATH = `/nonexistent-fh-dir-${process.pid}/fh.db`;
            await _resetFetcherHealthForTests(); // re-init against the bad path → disabled
            let threw = false;
            try {
                recordFetchOutcome("hostX", "ok"); // must not throw
            } catch {
                threw = true;
            }
            check("disabled: recordFetchOutcome did not throw", !threw);
            const { health, totals } = await readFetcherHealth(Date.now(), "dev", undefined, "1h");
            check("disabled: read returns empty maps", Object.keys(health).length === 0 && totals["1h"].ok === 0);
            const prune = await pruneFetcherHealth();
            check("disabled: prune reports disabled", prune.disabled === true && prune.deleted === 0);
            const stats = await _statsForTests();
            check("disabled: stats null", stats === null);
        }

        await _resetFetcherHealthForTests();
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
