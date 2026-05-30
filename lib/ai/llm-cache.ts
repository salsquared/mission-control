/**
 * Cross-tier LLM call deduplication (design: docs/archive/cross-tier-llm-dedup.html).
 *
 * dev (:4101 / dev.db) and prod (:3101 / prod.db) — plus their two schedulers
 * — run the SAME code on the SAME box against the SAME data, so every
 * LLM-backed step (email parse, posting classify, …) calls Gemini twice for
 * identical input, and bills twice. Once the Gmail push fan-out lands both
 * webhooks parse the same email within ~the same second.
 *
 * This module makes Gemini get called ONCE per unique input: a thin wrapper,
 * `llmCached(req, compute)`, content-hashes the request, checks a shared
 * SQLite file BOTH tiers open, and either returns a cached result, leads the
 * computation, or waits for the other tier's in-flight computation.
 *
 *   - The cache key is content-addressed (model + rendered prompt + output
 *     schema), so editing a prompt or bumping a model auto-invalidates — TTL
 *     (the prune job) is pure housekeeping, never correctness.
 *   - An in-flight reservation (INSERT OR IGNORE) gives single-flight even
 *     when both tiers fire simultaneously: exactly one leads, the other waits.
 *   - The cache is BEST-EFFORT and NEVER load-bearing. Any store-layer failure
 *     — better-sqlite3 ABI mismatch after an nvm Node switch, a missing/locked
 *     file, a write error — degrades to calling `compute()` directly. Dedup is
 *     an optimization; correctness must never depend on the cache being up.
 *
 * The store is the on-ramp to a future LLM gateway (one PM2 process both tiers
 * POST to, for a single shared rate bucket). Because callsites only ever touch
 * `llmCached(req, compute)`, that promotion swaps this module's body for a
 * `fetch()` without changing a single callsite. See the doc §7.
 */
import { createHash } from "node:crypto";
import { resolve as resolvePath } from "node:path";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Cache key
// ---------------------------------------------------------------------------

export interface CacheKeyParts {
    /** Resolved model id actually sent to Gemini (not the optional input). */
    model: string;
    system?: string;
    /** The fully-rendered user prompt. */
    user: string;
    /** Output contract — serialized with the same `z.toJSONSchema` api-docs uses. */
    schema: z.ZodType;
    temperature?: number;
    maxOutputTokens?: number;
}

// Serializing the output schema into the key gives auto-invalidation: add a
// field / tweak a `.describe()` ⇒ new JSON Schema ⇒ new key ⇒ never a stale
// hit. `z.toJSONSchema` can throw on exotic schemas (transforms etc.) — output
// schemas are plain object shapes so it won't in practice, but degrade to a
// stable sentinel rather than letting key-building throw (the prompt usually
// changes alongside the schema anyway, so dedup safety is preserved).
function schemaFingerprint(schema: z.ZodType): string {
    try {
        return JSON.stringify(z.toJSONSchema(schema, { io: "input" }));
    } catch {
        return "schema-unserializable";
    }
}

/** Content hash of everything that determines the output, nothing that doesn't. */
export function cacheKey(parts: CacheKeyParts): string {
    const payload = [
        parts.model,
        parts.system ?? "",
        parts.user,
        String(parts.temperature ?? ""),
        String(parts.maxOutputTokens ?? ""),
        schemaFingerprint(parts.schema),
    ].join("\u0000"); // NUL separator — collision-safe across the joined parts
    return createHash("sha256").update(payload).digest("hex");
}

// ---------------------------------------------------------------------------
// Shared store (a third SQLite file, neither tier's DB)
// ---------------------------------------------------------------------------

interface CacheRow {
    key: string;
    name: string | null;
    model: string | null;
    status: "pending" | "done";
    result: string | null;
    reserved_at: number;
    done_at: number | null;
}

interface Store {
    getRow(key: string): CacheRow | undefined;
    /** INSERT OR IGNORE — true means we won the reservation and should lead. */
    tryReserve(key: string, name: string, model: string, now: number): boolean;
    /** Conditional UPDATE on the old reserved_at — true means we won the steal. */
    trySteal(key: string, oldReservedAt: number, now: number): boolean;
    finish(key: string, result: string, now: number): void;
    release(key: string): void;
    prune(doneCutoffMs: number, pendingCutoffMs: number): number;
    /** Test seam: insert/overwrite a pending row with a chosen reserved_at. */
    seedPending(key: string, reservedAtMs: number): boolean;
    stats(): { total: number; done: number; pending: number };
    close(): void;
}

const DEFAULT_CACHE_PATH = "data/llm-cache.db";

// `undefined` = not yet initialized; a resolved `Store` or `null` (disabled)
// thereafter. The PROMISE is memoized so concurrent first-callers share one
// init instead of racing to open the file.
let storePromise: Promise<Store | null> | null = null;

async function initStore(): Promise<Store | null> {
    // Read the path at init time (not module-load) so a test that sets
    // LLM_CACHE_PATH then calls _resetLlmCacheForTests() picks up the change.
    const relOrAbs = process.env.LLM_CACHE_PATH ?? DEFAULT_CACHE_PATH;
    const abs = resolvePath(process.cwd(), relOrAbs);
    try {
        // Dynamic import (matches the repo convention for externalized native
        // deps — pdf-parse, mammoth, html-to-docx). Crucially this lets an
        // ABI-mismatch load failure REJECT here and be caught, degrading to a
        // no-op cache, instead of throwing at module-init and crashing every
        // importer of lib/ai/gemini.ts.
        const mod = await import("better-sqlite3");
        const Database = mod.default;
        const db = new Database(abs);
        db.pragma("journal_mode = WAL"); // many readers + one serialized writer across processes
        db.pragma("busy_timeout = 5000"); // brief cross-process write contention waits, doesn't throw
        db.pragma("synchronous = NORMAL"); // cache durability is non-critical; favor speed
        db.exec(`
            CREATE TABLE IF NOT EXISTS llm_cache (
                key         TEXT PRIMARY KEY,
                name        TEXT,
                model       TEXT,
                status      TEXT NOT NULL,
                result      TEXT,
                reserved_at INTEGER NOT NULL,
                done_at     INTEGER
            );
        `);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_llm_cache_done_at ON llm_cache(done_at);`);

        const getStmt = db.prepare(
            `SELECT key, name, model, status, result, reserved_at, done_at FROM llm_cache WHERE key = ?`,
        );
        const reserveStmt = db.prepare(
            `INSERT INTO llm_cache (key, name, model, status, reserved_at)
             VALUES (?, ?, ?, 'pending', ?)
             ON CONFLICT(key) DO NOTHING`,
        );
        const stealStmt = db.prepare(
            `UPDATE llm_cache SET reserved_at = ?
             WHERE key = ? AND reserved_at = ? AND status = 'pending'`,
        );
        const finishStmt = db.prepare(
            `UPDATE llm_cache SET status = 'done', result = ?, done_at = ? WHERE key = ?`,
        );
        const releaseStmt = db.prepare(`DELETE FROM llm_cache WHERE key = ?`);
        const pruneStmt = db.prepare(
            `DELETE FROM llm_cache
             WHERE (status = 'done' AND done_at IS NOT NULL AND done_at < ?)
                OR (status = 'pending' AND reserved_at < ?)`,
        );
        const seedStmt = db.prepare(
            `INSERT INTO llm_cache (key, name, model, status, reserved_at)
             VALUES (?, 'seed', 'seed', 'pending', ?)
             ON CONFLICT(key) DO UPDATE SET status = 'pending', reserved_at = excluded.reserved_at, result = NULL, done_at = NULL`,
        );
        const statsStmt = db.prepare(
            `SELECT COUNT(*) AS total,
                    SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done,
                    SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending
             FROM llm_cache`,
        );

        console.info(`[llm-cache] ready at ${abs} (WAL)`);

        return {
            getRow: (key) => getStmt.get(key) as CacheRow | undefined,
            tryReserve: (key, name, model, now) => reserveStmt.run(key, name, model, now).changes === 1,
            trySteal: (key, oldReservedAt, now) => stealStmt.run(now, key, oldReservedAt).changes === 1,
            finish: (key, result, now) => {
                finishStmt.run(result, now, key);
            },
            release: (key) => {
                releaseStmt.run(key);
            },
            prune: (doneCutoffMs, pendingCutoffMs) => pruneStmt.run(doneCutoffMs, pendingCutoffMs).changes,
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
    } catch (e) {
        // Most likely a native-binding ABI mismatch (better-sqlite3 built for a
        // different Node than the one running) or an unwritable path. Either
        // way: warn once, run uncached forever for this process.
        console.warn(
            `[llm-cache] disabled — store init failed; LLM calls will run UNCACHED:`,
            e instanceof Error ? e.message : e,
        );
        return null;
    }
}

function getStore(): Promise<Store | null> {
    if (!storePromise) storePromise = initStore();
    return storePromise;
}

// ---------------------------------------------------------------------------
// The reservation protocol: leader / follower / steal / fallback
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface LlmCachedReq {
    /** Content hash from cacheKey(). */
    key: string;
    /** Callsite name (chatJSON.name) — stored for observability only. */
    name: string;
    /** Resolved model id — stored for observability only. */
    model: string;
}

export interface LlmCachedOpts {
    /** A pending row older than this is presumed a dead leader and stealable. */
    leaseMs?: number;
    /** A follower waits at most this long before computing itself. */
    maxWaitMs?: number;
    pollMs?: number;
}

const DEFAULT_LEASE_MS = 30_000; // > worst-case Gemini latency incl. retries
const DEFAULT_MAX_WAIT_MS = 8_000;
const DEFAULT_POLL_MS = 150;

/**
 * Call Gemini once per unique input. `compute()` is the real (rate-limited)
 * model call; it runs only when WE are the leader (or on a best-effort
 * fallback). Errors from `compute()` propagate untouched and are NEVER cached;
 * errors from the store degrade to a direct `compute()`.
 */
export async function llmCached<T>(
    req: LlmCachedReq,
    compute: () => Promise<T>,
    opts?: LlmCachedOpts,
): Promise<T> {
    let store: Store | null;
    try {
        store = await getStore();
    } catch {
        store = null;
    }
    if (!store) return compute(); // cache disabled → direct, uncached

    const LEASE = opts?.leaseMs ?? DEFAULT_LEASE_MS;
    const MAX_WAIT = opts?.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
    const POLL = opts?.pollMs ?? DEFAULT_POLL_MS;

    // Initial check + reservation. Swallow ONLY store/parse errors here — the
    // lead() call happens OUTSIDE this try so a real compute() error propagates
    // untouched instead of being mistaken for a store failure (which would
    // wrongly re-run compute and double-bill).
    let leadNow = false;
    try {
        const hit = store.getRow(req.key);
        if (hit?.status === "done" && hit.result != null) return JSON.parse(hit.result) as T;
        if (store.tryReserve(req.key, req.name, req.model, Date.now())) leadNow = true; // we won → lead
    } catch (e) {
        console.warn(`[llm-cache] degraded to direct compute for ${req.name}:`, e instanceof Error ? e.message : e);
        return compute();
    }
    if (leadNow) return lead(store, req.key, compute);

    // Follower: poll for the leader's result; steal a stale lease; bail to
    // self-compute past MAX_WAIT (a rare duplicate, strictly better than hanging).
    const deadline = Date.now() + MAX_WAIT;
    while (Date.now() < deadline) {
        await sleep(POLL);
        let decision: "return" | "lead" | "wait" = "wait";
        let doneResult: T | undefined;
        try {
            const r = store.getRow(req.key);
            if (r?.status === "done" && r.result != null) {
                doneResult = JSON.parse(r.result) as T;
                decision = "return";
            } else if (!r && store.tryReserve(req.key, req.name, req.model, Date.now())) {
                decision = "lead"; // row released (leader errored) → re-lead
            } else if (
                r &&
                r.status === "pending" &&
                Date.now() - r.reserved_at > LEASE &&
                store.trySteal(req.key, r.reserved_at, Date.now())
            ) {
                decision = "lead"; // stale leader → atomic takeover
            }
        } catch (e) {
            console.warn(`[llm-cache] degraded to direct compute for ${req.name}:`, e instanceof Error ? e.message : e);
            return compute();
        }
        if (decision === "return") return doneResult as T;
        // lead() is called OUTSIDE the try so a compute() error propagates
        // rather than being mistaken for a store failure (which would re-run compute).
        if (decision === "lead") return lead(store, req.key, compute);
    }

    // Leader stalled past MAX_WAIT but is still alive — accept a rare duplicate.
    return compute();
}

async function lead<T>(store: Store, key: string, compute: () => Promise<T>): Promise<T> {
    let out: T;
    try {
        out = await compute();
    } catch (e) {
        // DELETE the reservation so the next caller leads cleanly. Errors are
        // never cached.
        try {
            store.release(key);
        } catch {
            /* best-effort */
        }
        throw e;
    }
    try {
        store.finish(key, JSON.stringify(out), Date.now());
    } catch {
        /* best-effort: result still returned, just not cached */
    }
    return out;
}

// ---------------------------------------------------------------------------
// Prune (housekeeping — content-addressed keys make eviction safe)
// ---------------------------------------------------------------------------

const DONE_RETENTION_DAYS = 60;
const PENDING_RETENTION_HOURS = 24; // a pending row this old is a crashed leader

export interface LlmCachePruneResult {
    deleted: number;
    doneCutoff: Date;
    pendingCutoff: Date;
    /** True when the cache is disabled (init failed) — nothing was pruned. */
    disabled: boolean;
}

export async function pruneLlmCache(opts?: {
    doneRetentionDays?: number;
    pendingRetentionHours?: number;
}): Promise<LlmCachePruneResult> {
    const doneDays = opts?.doneRetentionDays ?? DONE_RETENTION_DAYS;
    const pendHours = opts?.pendingRetentionHours ?? PENDING_RETENTION_HOURS;
    const doneCutoff = new Date(Date.now() - doneDays * 24 * 60 * 60 * 1000);
    const pendingCutoff = new Date(Date.now() - pendHours * 60 * 60 * 1000);

    let store: Store | null;
    try {
        store = await getStore();
    } catch {
        store = null;
    }
    if (!store) return { deleted: 0, doneCutoff, pendingCutoff, disabled: true };
    try {
        const deleted = store.prune(doneCutoff.getTime(), pendingCutoff.getTime());
        return { deleted, doneCutoff, pendingCutoff, disabled: false };
    } catch (e) {
        console.warn(`[llm-cache] prune failed:`, e instanceof Error ? e.message : e);
        return { deleted: 0, doneCutoff, pendingCutoff, disabled: true };
    }
}

// ---------------------------------------------------------------------------
// Test seams (used by scripts/tests/hermetic/llm-cache-smoke.ts)
// ---------------------------------------------------------------------------

/** Close the current store and reset the memo so the next call re-inits (picks up a new LLM_CACHE_PATH). */
export async function _resetLlmCacheForTests(): Promise<void> {
    if (storePromise) {
        const s = await storePromise.catch(() => null);
        if (s) s.close();
    }
    storePromise = null;
}

export async function _statsForTests(): Promise<{ total: number; done: number; pending: number } | null> {
    const s = await getStore();
    return s ? s.stats() : null;
}

export async function _seedPendingForTests(key: string, reservedAtMs: number): Promise<boolean> {
    const s = await getStore();
    return s ? s.seedPending(key, reservedAtMs) : false;
}
