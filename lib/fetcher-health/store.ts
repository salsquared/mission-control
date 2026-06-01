/**
 * Fetcher health store (design: docs/archive/fetcher-health-store.html).
 *
 * Replaces the old PM2-log-parsing FetcherHealthCard backend with a dedicated,
 * per-tier, best-effort SQLite store written at the fetch chokepoints
 * (loggedFetch → ok/error, serveStale → fallback, ScraperBrokenError → broken).
 * Mirrors the cross-PROCESS better-sqlite3 pattern proven by lib/ai/llm-cache.ts
 * — both the web and scheduler process of a tier write to one file — but the
 * data is per-TIER (a `tier` column; reads filter to the serving tier), NOT
 * cross-tier-merged like the LLM cache.
 *
 * Why a separate file and not a Prisma table: lib/prisma.ts logs every query
 * (prod), so a row per fetch would spam the in-app log viewer; and prod.db is
 * backed up as mailbox-equivalent — ephemeral 48h telemetry has no place there.
 *
 * BEST-EFFORT, never load-bearing. Any init/write failure degrades to a silent
 * no-op; the fetch path never sees an error from this subsystem. Cache HITS are
 * never recorded (a hit isn't an upstream touch — cacheStats already owns
 * hit/miss); only real upstream touches + their outcome land here.
 */
import { resolve as resolvePath } from "node:path";

export type FetchKind = "ok" | "error" | "fallback" | "broken";
export type Tier = "dev" | "prod";
export type Source = "web" | "scheduler";
export type WindowKey = "1h" | "6h" | "1d";

export interface HealthEntry {
    ok: number;
    error: number;
    fallback: number;
    broken: number;
}

const WINDOWS: readonly WindowKey[] = ["1h", "6h", "1d"] as const;
const WINDOW_MS: Record<WindowKey, number> = {
    "1h": 60 * 60 * 1000,
    "6h": 6 * 60 * 60 * 1000,
    "1d": 24 * 60 * 60 * 1000,
};

// We only ever query the last 24h; 48h retention leaves a day of slack so a
// skipped prune tick (or clock skew) never truncates the 1d window (OQ8).
const RETENTION_MS = 48 * 60 * 60 * 1000;

// tier / source are derived from the running process, not passed by callers:
//   - schedulers set MC_SCHEDULER_TIER=dev|prod (ecosystem.config.cjs)
//   - web processes pick the tier from NODE_ENV
// The presence of MC_SCHEDULER_TIER is what distinguishes scheduler from web.
export function currentTier(): Tier {
    const t = process.env.MC_SCHEDULER_TIER;
    if (t === "dev" || t === "prod") return t;
    return process.env.NODE_ENV === "production" ? "prod" : "dev";
}
export function currentSource(): Source {
    return process.env.MC_SCHEDULER_TIER ? "scheduler" : "web";
}

interface EventRow {
    ts: number;
    host: string;
    kind: string;
}

interface Store {
    insert(ts: number, host: string, kind: FetchKind, tier: Tier, source: Source): void;
    read(cutoffMs: number, tier: Tier, source: Source | null): EventRow[];
    prune(cutoffMs: number): number;
    stats(): { total: number };
    close(): void;
}

const DEFAULT_PATH = "data/fetcher-health.db";

// `undefined` until init settles, then a `Store` or `null` (disabled). The
// PROMISE is memoized so concurrent first-callers share one init; `resolvedStore`
// caches the settled value so the hot path can insert synchronously (OQ9).
let storePromise: Promise<Store | null> | null = null;
let resolvedStore: Store | null | undefined = undefined;

async function initStore(): Promise<Store | null> {
    // Read the path at init time (not module-load) so a test that sets
    // FETCHER_HEALTH_PATH then resets picks up the change.
    const relOrAbs = process.env.FETCHER_HEALTH_PATH ?? DEFAULT_PATH;
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
        db.pragma("synchronous = NORMAL"); // telemetry durability is non-critical; favor speed
        db.exec(`
            CREATE TABLE IF NOT EXISTS fetch_event (
                id     INTEGER PRIMARY KEY AUTOINCREMENT,
                ts     INTEGER NOT NULL,
                host   TEXT    NOT NULL,
                kind   TEXT    NOT NULL,
                tier   TEXT    NOT NULL,
                source TEXT
            );
        `);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_fetch_event_ts ON fetch_event(ts);`);

        const insertStmt = db.prepare(
            `INSERT INTO fetch_event (ts, host, kind, tier, source) VALUES (?, ?, ?, ?, ?)`,
        );
        const readAllStmt = db.prepare(
            `SELECT ts, host, kind FROM fetch_event WHERE ts >= ? AND tier = ?`,
        );
        const readSrcStmt = db.prepare(
            `SELECT ts, host, kind FROM fetch_event WHERE ts >= ? AND tier = ? AND source = ?`,
        );
        const pruneStmt = db.prepare(`DELETE FROM fetch_event WHERE ts < ?`);
        const countStmt = db.prepare(`SELECT COUNT(*) AS total FROM fetch_event`);

        console.info(`[fetcher-health] store ready at ${abs} (WAL)`);

        return {
            insert: (ts, host, kind, tier, source) => {
                insertStmt.run(ts, host, kind, tier, source);
            },
            read: (cutoffMs, tier, source) =>
                (source
                    ? readSrcStmt.all(cutoffMs, tier, source)
                    : readAllStmt.all(cutoffMs, tier)) as EventRow[],
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
            `[fetcher-health] disabled — store init failed; fetch outcomes will NOT be recorded:`,
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
 * Hot-path recorder. Fire-and-forget, swallows every error, never throws.
 * Records ONE row for a real upstream touch + its outcome; tier/source are
 * derived from the running process. After init settles the insert is a direct
 * synchronous write (OQ9); calls before init queue behind the init promise.
 */
export function recordFetchOutcome(host: string, kind: FetchKind): void {
    try {
        if (!host) return;
        const ts = Date.now();
        const tier = currentTier();
        const source = currentSource();
        if (resolvedStore !== undefined) {
            try {
                resolvedStore?.insert(ts, host, kind, tier, source);
            } catch {
                /* best-effort */
            }
            return;
        }
        // First calls before init settles → queue the (already-captured) row.
        void ensureStore().then((s) => {
            try {
                s?.insert(ts, host, kind, tier, source);
            } catch {
                /* best-effort */
            }
        });
    } catch {
        /* best-effort: never throw on the fetch path */
    }
}

function emptyEntry(): HealthEntry {
    return { ok: 0, error: 0, fallback: 0, broken: 0 };
}
function bumpKind(e: HealthEntry, kind: string): void {
    if (kind === "ok" || kind === "error" || kind === "fallback" || kind === "broken") e[kind]++;
}

export interface FetcherHealthResult {
    /** Per-host counts over the selected `window`. */
    health: Record<string, HealthEntry>;
    /** Totals for each of 1h / 6h / 1d (drive the badges). */
    totals: Record<WindowKey, HealthEntry>;
}

/**
 * Read path. Aggregates the last 24h of events for `tier` (optionally scoped to
 * a `source`) into 1h/6h/1d window totals plus a per-host map for the selected
 * `window` (defaults to 1d so the table isn't empty when recent activity is
 * sparse — the old hard-1h window was exactly what produced the "no activity"
 * bug). Returns empty maps if the store is disabled.
 */
export async function readFetcherHealth(
    nowMs: number,
    tier: Tier,
    source?: Source,
    window: WindowKey = "1d",
): Promise<FetcherHealthResult> {
    const totals: Record<WindowKey, HealthEntry> = {
        "1h": emptyEntry(),
        "6h": emptyEntry(),
        "1d": emptyEntry(),
    };
    const health: Record<string, HealthEntry> = {};

    let store: Store | null;
    try {
        store = await ensureStore();
    } catch {
        store = null;
    }
    if (!store) return { health, totals };

    const cutoff1d = nowMs - WINDOW_MS["1d"];
    const windowCutoff = nowMs - WINDOW_MS[window];
    let rows: EventRow[];
    try {
        rows = store.read(cutoff1d, tier, source ?? null);
    } catch {
        return { health, totals };
    }

    for (const row of rows) {
        if (row.ts < cutoff1d) continue;
        for (const w of WINDOWS) {
            if (row.ts >= nowMs - WINDOW_MS[w]) bumpKind(totals[w], row.kind);
        }
        if (row.ts >= windowCutoff) {
            if (!health[row.host]) health[row.host] = emptyEntry();
            bumpKind(health[row.host], row.kind);
        }
    }
    return { health, totals };
}

// ---------------------------------------------------------------------------
// Prune (housekeeping — we only ever query 24h, retain 48h)
// ---------------------------------------------------------------------------

export interface FetcherHealthPruneResult {
    deleted: number;
    cutoff: Date;
    /** True when the store is disabled (init failed) — nothing was pruned. */
    disabled: boolean;
}

export async function pruneFetcherHealth(opts?: {
    retentionMs?: number;
}): Promise<FetcherHealthPruneResult> {
    const retention = opts?.retentionMs ?? RETENTION_MS;
    const cutoff = new Date(Date.now() - retention);
    let store: Store | null;
    try {
        store = await ensureStore();
    } catch {
        store = null;
    }
    if (!store) return { deleted: 0, cutoff, disabled: true };
    try {
        return { deleted: store.prune(cutoff.getTime()), cutoff, disabled: false };
    } catch (e) {
        console.warn(`[fetcher-health] prune failed:`, e instanceof Error ? e.message : e);
        return { deleted: 0, cutoff, disabled: true };
    }
}

// ---------------------------------------------------------------------------
// Test seams (used by scripts/tests/hermetic/fetcher-health-store-smoke.ts)
// ---------------------------------------------------------------------------

/** Close the current store + reset the memo so the next call re-inits (picks up a new FETCHER_HEALTH_PATH). */
export async function _resetFetcherHealthForTests(): Promise<void> {
    if (storePromise) {
        const s = await storePromise.catch(() => null);
        if (s) s.close();
    }
    storePromise = null;
    resolvedStore = undefined;
}

/** Synchronous-once-ready insert with explicit ts/tier/source — lets a smoke seed events across window boundaries. */
export async function _recordForTests(
    ts: number,
    host: string,
    kind: FetchKind,
    tier: Tier,
    source: Source,
): Promise<boolean> {
    const s = await ensureStore();
    if (!s) return false;
    try {
        s.insert(ts, host, kind, tier, source);
        return true;
    } catch {
        return false;
    }
}

export async function _statsForTests(): Promise<{ total: number } | null> {
    const s = await ensureStore();
    return s ? s.stats() : null;
}
