/**
 * Hermetic smoke for the shared-cache SCHEMA-DRIFT self-heal (2026-06-04).
 *
 * Background — the silent failure this prevents:
 *   The cache file (data/llm-cache.db) outlives the code. The 2026-05-31 refactor
 *   that re-homed the LLM cache onto lib/shared-sqlite-cache.ts renamed the payload
 *   column `result`→`value` and added `expiry`, but kept the SAME table name in the
 *   SAME file. `CREATE TABLE IF NOT EXISTS` no-ops on a pre-existing old-shape
 *   table, so the next db.prepare("… value …") threw `no such column: value` →
 *   initStore() caught it as a generic failure → the store disabled itself and ran
 *   EVERY call uncached, permanently + invisibly (one warn in a ring buffer). It sat
 *   broken from 05-31 until the 2026-06-02 self-notification spam made the wasted
 *   Gemini spend visible.
 *
 * The fix: reconcileSchema() detects a column mismatch on init and DROPs+rebuilds
 * the table (the data is throwaway), LOUDLY, instead of disabling.
 *
 * What we assert — driving the REAL llm-cache adapter against a temp file we
 * pre-seed with the OLD schema:
 *   A. Loud, not silent — init emits a "SCHEMA DRIFT" warning.
 *   B. Self-heal — the cache is HEALTHY after init (stats non-null = NOT disabled).
 *   C. Actually caches — a second identical call is a cache hit (compute runs once).
 *   D. Table rebuilt — the on-disk table now has the new columns (value, expiry)
 *      and no longer has the stale `result` column.
 *   E. No-op on a matching schema — a re-init against the now-correct table does
 *      NOT log another drift warning (idempotent).
 *
 * Hermetic: own temp DB, fake compute, no network/PM2. Cleans up after itself.
 *
 *   npx tsx scripts/tests/hermetic/shared-cache-schema-drift-smoke.ts
 */
import { unlinkSync } from "node:fs";
import { z } from "zod";

let passed = 0;
let failed = 0;
function check(name: string, condition: boolean, detail?: string) {
    if (condition) { console.log(`[PASS] ${name}`); passed++; }
    else { console.error(`[FAIL] ${name}${detail ? ` — ${detail}` : ""}`); failed++; }
}

const SCHEMA = z.object({ v: z.number() });
const TMP_DB = `/tmp/shared-cache-drift-smoke-${process.pid}-${Date.now()}.db`;

// The OLD (pre-2026-05-31) llm_cache shape: payload col `result` (not `value`),
// extra name/model cols, no `expiry`. Seeding this reproduces the silent-disable.
const OLD_SCHEMA = `CREATE TABLE llm_cache (
    key TEXT PRIMARY KEY, name TEXT, model TEXT, status TEXT NOT NULL,
    result TEXT, reserved_at INTEGER NOT NULL, done_at INTEGER
);`;

async function seedOldSchema(path: string): Promise<void> {
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(path);
    db.exec(OLD_SCHEMA);
    db.prepare(
        `INSERT INTO llm_cache (key, name, model, status, result, reserved_at, done_at)
         VALUES ('stale', 'old', 'old', 'done', '{"v":1}', 0, 0)`,
    ).run();
    db.close();
}

async function columnsOf(path: string): Promise<string[]> {
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(path, { readonly: true });
    const cols = db.prepare(`PRAGMA table_info("llm_cache")`).all().map((r: any) => r.name as string);
    db.close();
    return cols;
}

async function main() {
    // Capture console.warn so we can assert the drift was logged LOUDLY (case A).
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };

    process.env.LLM_CACHE_PATH = TMP_DB;
    await seedOldSchema(TMP_DB); // <- the broken, pre-existing file

    const { cacheKey, llmCached, _resetLlmCacheForTests, _statsForTests } = await import("@/lib/ai/llm-cache");
    await _resetLlmCacheForTests(); // next store touch → reconcileSchema runs

    try {
        // A call that, before the fix, would have run uncached forever.
        const key = cacheKey({ model: "m1", user: "drift", schema: SCHEMA });
        let calls = 0;
        const compute = async () => { calls++; return { v: 7 }; };
        const r1 = await llmCached({ key, name: "smoke", model: "m1" }, compute);
        const r2 = await llmCached({ key, name: "smoke", model: "m1" }, compute);

        const stats = await _statsForTests();
        console.warn = origWarn; // restore before asserting/printing

        check("A: init emitted a SCHEMA DRIFT warning (not silent)",
            warnings.some((w) => /schema drift/i.test(w)),
            `warnings=${JSON.stringify(warnings)}`);
        check("B: cache is healthy after drift (stats non-null = NOT disabled)",
            stats !== null, `stats=${JSON.stringify(stats)}`);
        check("C: compute ran exactly once across two identical calls (cache hit)",
            calls === 1, `calls=${calls}`);
        check("C: both calls returned the same value", r1.v === 7 && r2.v === 7);

        const cols = await columnsOf(TMP_DB);
        check("D: rebuilt table has the new `value` column", cols.includes("value"), `cols=${cols.join(",")}`);
        check("D: rebuilt table has the new `expiry` column", cols.includes("expiry"), `cols=${cols.join(",")}`);
        check("D: rebuilt table dropped the stale `result` column", !cols.includes("result"), `cols=${cols.join(",")}`);

        // E. Re-init against the now-healthy file must NOT report drift again.
        const warnings2: string[] = [];
        console.warn = (...args: unknown[]) => { warnings2.push(args.map(String).join(" ")); };
        await _resetLlmCacheForTests();
        await llmCached(
            { key: cacheKey({ model: "m1", user: "again", schema: SCHEMA }), name: "smoke", model: "m1" },
            compute,
        );
        console.warn = origWarn;
        check("E: a matching schema is NOT rebuilt (no second drift warning)",
            !warnings2.some((w) => /schema drift/i.test(w)),
            `warnings2=${JSON.stringify(warnings2)}`);

        await _resetLlmCacheForTests();
    } finally {
        console.warn = origWarn;
        for (const suffix of ["", "-wal", "-shm"]) {
            try { unlinkSync(TMP_DB + suffix); } catch { /* may not exist */ }
        }
    }

    console.log(`\n${passed}/${passed + failed} steps passed`);
    if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error("smoke crashed:", e); process.exit(1); });
