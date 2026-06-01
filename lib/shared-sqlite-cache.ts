/**
 * Shared cross-tier SQLite cache base (docs/arxiv-rate-limit-fix.html Layer 1, OQ5/OQ7).
 *
 * dev (:4101/dev.db) and prod (:3101/prod.db) — plus both schedulers — run the
 * SAME code on one box against the SAME data. Anything cacheable that each tier
 * computes independently gets computed twice. This module is the "fat base": a
 * generic keyed store, opened on a THIRD SQLite file (neither tier's Prisma DB),
 * carrying a cross-tier single-flight protocol (reserve → lead/compute → finish,
 * with follower poll + stale-lease steal) so simultaneous misses across tiers
 * run `compute` exactly ONCE.
 *
 * Two callers build on it (both thin adapters):
 *   - lib/ai/llm-cache.ts        — content-addressed keys, NO expiry (a `done`
 *                                   row is valid until pruned by age).
 *   - lib/research/shared-cache.ts — path+query keys WITH a TTL/expiry (a `done`
 *                                   row past its expiry is re-led, like a miss).
 * The single difference is the optional `ttlSeconds` on getOrCompute(): absent →
 * `expiry = NULL` → llm-cache semantics; present → TTL'd → research semantics.
 *
 * BEST-EFFORT, NEVER load-bearing: any store-layer failure (better-sqlite3 ABI
 * mismatch after an nvm Node switch, unwritable file, lock) degrades to a direct
 * uncached `compute()`. Correctness must never depend on the file being up.
 *
 * `openDb()` is also exported as a low-level seam for non-keyed callers — the
 * Layer 3 arXiv rate bucket (OQ9) opens its own single-row table over it and
 * keeps its own BEGIN IMMEDIATE logic, reusing only the guarded-open/WAL/degrade.
 */
import { resolve as resolvePath } from "node:path";

// The native handle is loosely typed — better-sqlite3 is a dynamically-imported
// native module (serverExternalPackages), so we avoid a hard type dependency.
type Db = any;

// ---------------------------------------------------------------------------
// Low-level seam — guarded open / WAL / best-effort degrade (OQ9 reuses this)
// ---------------------------------------------------------------------------

/**
 * Open a better-sqlite3 database at `relOrAbs` (relative paths resolve from
 * process.cwd()) with the house pragmas (WAL, busy_timeout, synchronous=NORMAL).
 * Returns the Database handle, or `null` if the native module can't load or the
 * file can't be opened — callers degrade rather than crash. The dynamic import
 * lets an ABI-mismatch failure REJECT here (caught) instead of throwing at
 * module-init and taking down every importer.
 */
export async function openDb(relOrAbs: string): Promise<Db | null> {
    try {
        const abs = resolvePath(process.cwd(), relOrAbs);
        const mod = await import("better-sqlite3");
        const Database = mod.default;
        const db = new Database(abs);
        db.pragma("journal_mode = WAL"); // many readers + one serialized writer across processes
        db.pragma("busy_timeout = 5000"); // brief cross-process write contention waits, doesn't throw
        db.pragma("synchronous = NORMAL"); // cache durability is non-critical; favor speed
        return db;
    } catch (e) {
        console.warn(
            `[shared-cache] openDb failed for ${relOrAbs} — caller will run uncached:`,
            e instanceof Error ? e.message : e,
        );
        return null;
    }
}

// ---------------------------------------------------------------------------
// Generic keyed single-flight store
// ---------------------------------------------------------------------------

interface CacheRow {
    key: string;
    value: string | null;
    status: "pending" | "done";
    expiry: number | null; // ms epoch; NULL = never expires
    reserved_at: number;
    done_at: number | null;
}

interface InternalStore {
    getRow(key: string): CacheRow | undefined;
    /** INSERT OR IGNORE — true means no prior row existed and we won the lead. */
    tryReserveFresh(key: string, now: number): boolean;
    /** Reclaim an expired `done` row back to pending — true means we won. */
    tryReclaimExpired(key: string, now: number): boolean;
    /** Steal a stale `pending` lease (conditional on its old reserved_at). */
    trySteal(key: string, oldReservedAt: number, now: number): boolean;
    finish(key: string, value: string, expiry: number | null, now: number): void;
    release(key: string): void;
    prune(doneCutoffMs: number, pendingCutoffMs: number, now: number): number;
    seedPending(key: string, reservedAtMs: number): boolean;
    stats(): { total: number; done: number; pending: number };
    close(): void;
}

export interface GetOrComputeOpts {
    /** Lifetime of a freshly-computed entry. Absent/null → never expires. */
    ttlSeconds?: number | null;
    /** Force a recompute: drop any existing row first (cache-buster path). */
    force?: boolean;
    /** A pending row older than this (ms) is a presumed-dead leader, stealable. */
    leaseMs?: number;
    /** A follower waits at most this long (ms) before computing itself. */
    maxWaitMs?: number;
    pollMs?: number;
}

export interface PruneResult {
    deleted: number;
    /** True when the store is disabled (init failed) — nothing was pruned. */
    disabled: boolean;
}

export interface SharedCache {
    getOrCompute<T>(key: string, compute: () => Promise<T>, opts?: GetOrComputeOpts): Promise<T>;
    /** Delete a single key from the shared store (cross-tier invalidation). */
    invalidate(key: string): Promise<void>;
    prune(doneCutoffMs: number, pendingCutoffMs: number): Promise<PruneResult>;
    /** Telemetry; null when the store is disabled. */
    stats(): Promise<{ total: number; done: number; pending: number } | null>;
    // --- test seams ---
    _reset(): Promise<void>;
    _seedPending(key: string, reservedAtMs: number): Promise<boolean>;
}

export interface SharedCacheConfig {
    /** Read lazily (not at module load) so tests can swap the env path then _reset(). */
    resolvePath: () => string;
    /** SQLite table name (one file may host several adapters' tables). */
    table: string;
    /** Short label for log lines, e.g. "research-cache". */
    label: string;
}

const DEFAULT_LEASE_MS = 30_000; // > worst-case compute latency incl. retries
const DEFAULT_MAX_WAIT_MS = 8_000;
const DEFAULT_POLL_MS = 150;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function buildInternalStore(db: Db, table: string): InternalStore {
    db.exec(`
        CREATE TABLE IF NOT EXISTS ${table} (
            key         TEXT PRIMARY KEY,
            value       TEXT,
            status      TEXT NOT NULL,
            expiry      INTEGER,
            reserved_at INTEGER NOT NULL,
            done_at     INTEGER
        );
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_done_at ON ${table}(done_at);`);

    const getStmt = db.prepare(
        `SELECT key, value, status, expiry, reserved_at, done_at FROM ${table} WHERE key = ?`,
    );
    const reserveStmt = db.prepare(
        `INSERT INTO ${table} (key, status, reserved_at) VALUES (?, 'pending', ?) ON CONFLICT(key) DO NOTHING`,
    );
    const reclaimStmt = db.prepare(
        `UPDATE ${table} SET status = 'pending', reserved_at = ?, value = NULL, done_at = NULL, expiry = NULL
         WHERE key = ? AND status = 'done' AND expiry IS NOT NULL AND expiry < ?`,
    );
    const stealStmt = db.prepare(
        `UPDATE ${table} SET reserved_at = ? WHERE key = ? AND reserved_at = ? AND status = 'pending'`,
    );
    const finishStmt = db.prepare(
        `UPDATE ${table} SET status = 'done', value = ?, expiry = ?, done_at = ? WHERE key = ?`,
    );
    const releaseStmt = db.prepare(`DELETE FROM ${table} WHERE key = ?`);
    const pruneStmt = db.prepare(
        `DELETE FROM ${table}
         WHERE (status = 'done' AND done_at IS NOT NULL AND done_at < ?)
            OR (status = 'pending' AND reserved_at < ?)
            OR (status = 'done' AND expiry IS NOT NULL AND expiry < ?)`,
    );
    const seedStmt = db.prepare(
        `INSERT INTO ${table} (key, status, reserved_at) VALUES (?, 'pending', ?)
         ON CONFLICT(key) DO UPDATE SET status = 'pending', reserved_at = excluded.reserved_at, value = NULL, done_at = NULL, expiry = NULL`,
    );
    const statsStmt = db.prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done,
                SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending
         FROM ${table}`,
    );

    return {
        getRow: (key) => getStmt.get(key) as CacheRow | undefined,
        tryReserveFresh: (key, now) => reserveStmt.run(key, now).changes === 1,
        tryReclaimExpired: (key, now) => reclaimStmt.run(now, key, now).changes === 1,
        trySteal: (key, oldReservedAt, now) => stealStmt.run(now, key, oldReservedAt).changes === 1,
        finish: (key, value, expiry, now) => {
            finishStmt.run(value, expiry, now, key);
        },
        release: (key) => {
            releaseStmt.run(key);
        },
        prune: (doneCutoffMs, pendingCutoffMs, now) =>
            pruneStmt.run(doneCutoffMs, pendingCutoffMs, now).changes,
        seedPending: (key, reservedAtMs) => seedStmt.run(key, reservedAtMs).changes >= 1,
        stats: () => {
            const r = statsStmt.get() as { total: number; done: number | null; pending: number | null };
            return { total: r.total ?? 0, done: Number(r.done ?? 0), pending: Number(r.pending ?? 0) };
        },
        close: () => {
            try {
                db.close();
            } catch {
                /* best-effort */
            }
        },
    };
}

export function createSharedCache(config: SharedCacheConfig): SharedCache {
    // `undefined` = not yet initialized; resolved `InternalStore` or `null`
    // (disabled) thereafter. The PROMISE is memoized so concurrent first-callers
    // share one init instead of racing to open the file.
    let storePromise: Promise<InternalStore | null> | null = null;

    async function initStore(): Promise<InternalStore | null> {
        const path = config.resolvePath();
        const db = await openDb(path);
        if (!db) {
            console.warn(`[${config.label}] disabled — store init failed; running UNCACHED`);
            return null;
        }
        try {
            const store = buildInternalStore(db, config.table);
            console.info(`[${config.label}] ready at ${resolvePath(process.cwd(), path)} (WAL, table=${config.table})`);
            return store;
        } catch (e) {
            console.warn(`[${config.label}] disabled — table init failed; running UNCACHED:`, e instanceof Error ? e.message : e);
            try {
                db.close();
            } catch {
                /* best-effort */
            }
            return null;
        }
    }

    function getStore(): Promise<InternalStore | null> {
        if (!storePromise) storePromise = initStore();
        return storePromise;
    }

    function isExpired(row: CacheRow, now: number): boolean {
        return row.expiry != null && row.expiry < now;
    }

    async function lead<T>(
        store: InternalStore,
        key: string,
        compute: () => Promise<T>,
        ttlSeconds: number | null | undefined,
    ): Promise<T> {
        let out: T;
        try {
            out = await compute();
        } catch (e) {
            // Errors are NEVER cached — drop the reservation so the next caller leads cleanly.
            try {
                store.release(key);
            } catch {
                /* best-effort */
            }
            throw e;
        }
        try {
            const expiry = ttlSeconds != null ? Date.now() + ttlSeconds * 1000 : null;
            store.finish(key, JSON.stringify(out), expiry, Date.now());
        } catch {
            /* best-effort: result still returned, just not cached */
        }
        return out;
    }

    async function getOrCompute<T>(
        key: string,
        compute: () => Promise<T>,
        opts?: GetOrComputeOpts,
    ): Promise<T> {
        let store: InternalStore | null;
        try {
            store = await getStore();
        } catch {
            store = null;
        }
        if (!store) return compute(); // cache disabled → direct, uncached

        const LEASE = opts?.leaseMs ?? DEFAULT_LEASE_MS;
        const MAX_WAIT = opts?.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
        const POLL = opts?.pollMs ?? DEFAULT_POLL_MS;
        const ttlSeconds = opts?.ttlSeconds;

        if (opts?.force) {
            // Cache-buster: drop any existing row so we re-lead a fresh compute.
            try {
                store.release(key);
            } catch {
                /* best-effort */
            }
        }

        // Initial check + reservation. Swallow ONLY store/parse errors here — the
        // lead() call happens OUTSIDE this try so a real compute() error propagates
        // untouched instead of being mistaken for a store failure (double-billing).
        let leadNow = false;
        try {
            const hit = store.getRow(key);
            if (hit?.status === "done" && hit.value != null && !isExpired(hit, Date.now())) {
                return JSON.parse(hit.value) as T;
            }
            const now = Date.now();
            if (!hit) {
                if (store.tryReserveFresh(key, now)) leadNow = true;
            } else if (hit.status === "done") {
                // expired done → reclaim to pending and re-lead
                if (store.tryReclaimExpired(key, now)) leadNow = true;
            }
            // else: pending → fall through to the follower loop
        } catch (e) {
            console.warn(`[${config.label}] degraded to direct compute for ${key.slice(0, 24)}:`, e instanceof Error ? e.message : e);
            return compute();
        }
        if (leadNow) return lead(store, key, compute, ttlSeconds);

        // Follower: poll for the leader's result; reclaim/steal a stale row; bail
        // to self-compute past MAX_WAIT (a rare duplicate, better than hanging).
        const deadline = Date.now() + MAX_WAIT;
        while (Date.now() < deadline) {
            await sleep(POLL);
            let decision: "return" | "lead" | "wait" = "wait";
            let doneResult: T | undefined;
            try {
                const now = Date.now();
                const r = store.getRow(key);
                if (r?.status === "done" && r.value != null && !isExpired(r, now)) {
                    doneResult = JSON.parse(r.value) as T;
                    decision = "return";
                } else if (!r && store.tryReserveFresh(key, now)) {
                    decision = "lead"; // row released (leader errored) → re-lead
                } else if (r && r.status === "done" && isExpired(r, now) && store.tryReclaimExpired(key, now)) {
                    decision = "lead"; // expired done → reclaim
                } else if (
                    r &&
                    r.status === "pending" &&
                    now - r.reserved_at > LEASE &&
                    store.trySteal(key, r.reserved_at, now)
                ) {
                    decision = "lead"; // stale leader → atomic takeover
                }
            } catch (e) {
                console.warn(`[${config.label}] degraded to direct compute for ${key.slice(0, 24)}:`, e instanceof Error ? e.message : e);
                return compute();
            }
            if (decision === "return") return doneResult as T;
            if (decision === "lead") return lead(store, key, compute, ttlSeconds);
        }

        // Leader stalled past MAX_WAIT but is still alive — accept a rare duplicate.
        return compute();
    }

    async function invalidate(key: string): Promise<void> {
        let store: InternalStore | null;
        try {
            store = await getStore();
        } catch {
            store = null;
        }
        if (!store) return;
        try {
            store.release(key);
        } catch {
            /* best-effort */
        }
    }

    async function prune(doneCutoffMs: number, pendingCutoffMs: number): Promise<PruneResult> {
        let store: InternalStore | null;
        try {
            store = await getStore();
        } catch {
            store = null;
        }
        if (!store) return { deleted: 0, disabled: true };
        try {
            const deleted = store.prune(doneCutoffMs, pendingCutoffMs, Date.now());
            return { deleted, disabled: false };
        } catch (e) {
            console.warn(`[${config.label}] prune failed:`, e instanceof Error ? e.message : e);
            return { deleted: 0, disabled: true };
        }
    }

    async function stats() {
        const store = await getStore().catch(() => null);
        return store ? store.stats() : null;
    }

    async function _reset(): Promise<void> {
        if (storePromise) {
            const s = await storePromise.catch(() => null);
            if (s) s.close();
        }
        storePromise = null;
    }

    async function _seedPending(key: string, reservedAtMs: number): Promise<boolean> {
        const store = await getStore().catch(() => null);
        return store ? store.seedPending(key, reservedAtMs) : false;
    }

    return { getOrCompute, invalidate, prune, stats, _reset, _seedPending };
}
