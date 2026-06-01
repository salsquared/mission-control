/**
 * Scheduler structured-log bridge (design: docs/scheduler-structured-logs.html).
 *
 * The scheduler processes run their own structured logger (scheduler/index.ts
 * calls initLogger()), but their ring buffer is per-process and the web tier's
 * in-app log viewer can't see it. This is the cross-PROCESS bridge: the
 * scheduler subscribes a listener that writes every log line into a shared
 * SQLite file `data/logs.db`, and the web tier's SSE + historical routes read
 * from it (live ~1s poll + windowed history). Same better-sqlite3 cross-process
 * pattern as lib/ai/llm-cache.ts / lib/fetcher-health/store.ts.
 *
 * SCHEDULER-ONLY SINK (OQ8): only the scheduler writes here — the web process
 * keeps its instant in-memory ring + SSE untouched and merely READS this store
 * for the scheduler's rows. Both tiers (dev + prod) write to the one file with
 * a `tier` column; reads filter to the serving process's tier (LOG_TIER).
 *
 * BEST-EFFORT, never load-bearing. Any init/write failure degrades to a silent
 * no-op; the logging path never sees an error from this subsystem.
 */
import { resolve as resolvePath } from "node:path";
import type { LogEntry, LogTier } from "@/lib/logger";

// We only ever query the last 24h from the viewer; 48h retention leaves a day
// of slack so a skipped prune tick never truncates the visible window. Mirrors
// the fetcher-health store.
const RETENTION_MS = 48 * 60 * 60 * 1000;

export interface LogRow {
    id: number;
    ts: number;
    level: string;
    source: string;
    tier: string;
    msg: string;
}

interface Store {
    insert(ts: number, level: string, source: string, tier: string, msg: string): void;
    since(cursorId: number, tier: LogTier, limit: number): LogRow[];
    window(fromMs: number, toMs: number, tier: LogTier, limit: number): LogRow[];
    latestId(): number;
    prune(cutoffMs: number): number;
    stats(): { total: number };
    close(): void;
}

const DEFAULT_PATH = "data/logs.db";

// `undefined` until init settles, then a `Store` or `null` (disabled). The
// PROMISE is memoized so concurrent first-callers share one init; `resolvedStore`
// caches the settled value so the hot path can insert synchronously.
let storePromise: Promise<Store | null> | null = null;
let resolvedStore: Store | null | undefined = undefined;

async function initStore(): Promise<Store | null> {
    // Read the path at init time (not module-load) so a test that sets
    // LOGS_DB_PATH then resets picks up the change.
    const relOrAbs = process.env.LOGS_DB_PATH ?? DEFAULT_PATH;
    const abs = resolvePath(process.cwd(), relOrAbs);
    try {
        // Guarded dynamic import (repo convention for externalized native deps).
        // An ABI-mismatch load failure REJECTS here and is caught, degrading to
        // a no-op recorder rather than throwing at module-init.
        const mod = await import("better-sqlite3");
        const Database = mod.default;
        const db = new Database(abs);
        db.pragma("journal_mode = WAL"); // many readers + one serialized writer across processes
        db.pragma("busy_timeout = 5000"); // brief cross-process write contention waits, doesn't throw
        db.pragma("synchronous = NORMAL"); // log durability is non-critical; favor speed
        db.exec(`
            CREATE TABLE IF NOT EXISTS log_line (
                id     INTEGER PRIMARY KEY AUTOINCREMENT,
                ts     INTEGER NOT NULL,
                level  TEXT    NOT NULL,
                source TEXT    NOT NULL,
                tier   TEXT    NOT NULL,
                msg    TEXT    NOT NULL
            );
        `);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_log_line_ts ON log_line(ts);`);

        const insertStmt = db.prepare(
            `INSERT INTO log_line (ts, level, source, tier, msg) VALUES (?, ?, ?, ?, ?)`,
        );
        // Live tail: rows newer than the caller's cursor, oldest-first so the
        // viewer appends in order; tier-scoped to the serving process.
        const sinceStmt = db.prepare(
            `SELECT id, ts, level, source, tier, msg FROM log_line
             WHERE id > ? AND tier = ? ORDER BY id ASC LIMIT ?`,
        );
        // Historical: a time window, newest-first then sliced by the caller.
        const windowStmt = db.prepare(
            `SELECT id, ts, level, source, tier, msg FROM log_line
             WHERE ts >= ? AND ts <= ? AND tier = ? ORDER BY ts DESC LIMIT ?`,
        );
        const latestStmt = db.prepare(`SELECT MAX(id) AS maxId FROM log_line`);
        const pruneStmt = db.prepare(`DELETE FROM log_line WHERE ts < ?`);
        const countStmt = db.prepare(`SELECT COUNT(*) AS total FROM log_line`);

        console.info(`[logs-store] store ready at ${abs} (WAL)`);

        return {
            insert: (ts, level, source, tier, msg) => {
                insertStmt.run(ts, level, source, tier, msg);
            },
            since: (cursorId, tier, limit) =>
                sinceStmt.all(cursorId, tier, limit) as LogRow[],
            window: (fromMs, toMs, tier, limit) =>
                windowStmt.all(fromMs, toMs, tier, limit) as LogRow[],
            latestId: () => {
                const r = latestStmt.get() as { maxId: number | null };
                return Number(r.maxId ?? 0);
            },
            prune: (cutoffMs) => pruneStmt.run(cutoffMs).changes,
            stats: () => {
                const r = countStmt.get() as { total: number | null };
                return { total: Number(r.total ?? 0) };
            },
            close: () => {
                try {
                    db.close();
                } catch {
                    /* best-effort */
                }
            },
        };
    } catch (e) {
        console.warn(
            `[logs-store] disabled — store init failed; scheduler logs will NOT reach the in-app viewer:`,
            e instanceof Error ? e.message : e,
        );
        return null;
    }
}

function ensureStore(): Promise<Store | null> {
    if (!storePromise) {
        storePromise = initStore()
            .then((s) => {
                resolvedStore = s;
                return s;
            })
            .catch(() => {
                resolvedStore = null;
                return null;
            });
    }
    return storePromise;
}

/**
 * Hot-path recorder — the scheduler's subscribeToLogs() listener. Fire-and-
 * forget, swallows every error, never throws. The LogEntry already carries the
 * stamped source/tier (from initLogger), so we store them verbatim. After init
 * settles the insert is a direct synchronous write; calls before init queue
 * behind the init promise.
 */
export function recordLogLine(entry: LogEntry): void {
    try {
        const ts = Date.parse(entry.timestamp);
        if (Number.isNaN(ts)) return;
        const { level, source, tier, message } = entry;
        if (resolvedStore !== undefined) {
            try {
                resolvedStore?.insert(ts, level, source, tier, message);
            } catch {
                /* best-effort */
            }
            return;
        }
        // First calls before init settles → queue the (already-captured) row.
        void ensureStore().then((s) => {
            try {
                s?.insert(ts, level, source, tier, message);
            } catch {
                /* best-effort */
            }
        });
    } catch {
        /* best-effort: never throw on the logging path */
    }
}

/** Live-tail read: scheduler rows with id > cursorId for `tier`, oldest-first. */
export async function readLogsSince(
    cursorId: number,
    tier: LogTier,
    limit = 500,
): Promise<LogRow[]> {
    const store = await ensureStore().catch(() => null);
    if (!store) return [];
    try {
        return store.since(cursorId, tier, limit);
    } catch {
        return [];
    }
}

/** Historical read: scheduler rows in [fromMs, toMs] for `tier`, newest-first. */
export async function readLogsWindow(
    fromMs: number,
    toMs: number,
    tier: LogTier,
    limit = 1000,
): Promise<LogRow[]> {
    const store = await ensureStore().catch(() => null);
    if (!store) return [];
    try {
        return store.window(fromMs, toMs, tier, limit);
    } catch {
        return [];
    }
}

/** Current max row id — lets an SSE connect seed its cursor to "now". */
export async function latestLogId(): Promise<number> {
    const store = await ensureStore().catch(() => null);
    if (!store) return 0;
    try {
        return store.latestId();
    } catch {
        return 0;
    }
}

// ---------------------------------------------------------------------------
// Prune (housekeeping — viewer queries 24h, retain 48h)
// ---------------------------------------------------------------------------

export interface LogsPruneResult {
    deleted: number;
    cutoff: Date;
    /** True when the store is disabled (init failed) — nothing was pruned. */
    disabled: boolean;
}

export async function pruneLogs(opts?: { retentionMs?: number }): Promise<LogsPruneResult> {
    const retention = opts?.retentionMs ?? RETENTION_MS;
    const cutoff = new Date(Date.now() - retention);
    const store = await ensureStore().catch(() => null);
    if (!store) return { deleted: 0, cutoff, disabled: true };
    try {
        return { deleted: store.prune(cutoff.getTime()), cutoff, disabled: false };
    } catch (e) {
        console.warn(`[logs-store] prune failed:`, e instanceof Error ? e.message : e);
        return { deleted: 0, cutoff, disabled: true };
    }
}

// ---------------------------------------------------------------------------
// Test seams (scripts/tests/hermetic/logs-store-smoke.ts)
// ---------------------------------------------------------------------------

/** Close the current store + reset the memo so the next call re-inits (picks up a new LOGS_DB_PATH). */
export async function _resetLogsStoreForTests(): Promise<void> {
    if (storePromise) {
        const s = await storePromise.catch(() => null);
        if (s) s.close();
    }
    storePromise = null;
    resolvedStore = undefined;
}

/** Synchronous-once-ready insert with explicit ts/tier — lets a smoke seed rows across window/cursor boundaries. */
export async function _recordForTests(
    ts: number,
    level: string,
    source: string,
    tier: string,
    msg: string,
): Promise<boolean> {
    const s = await ensureStore();
    if (!s) return false;
    try {
        s.insert(ts, level, source, tier, msg);
        return true;
    } catch {
        return false;
    }
}

export async function _statsForTests(): Promise<{ total: number } | null> {
    const s = await ensureStore();
    return s ? s.stats() : null;
}
