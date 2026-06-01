/**
 * Cross-tier LLM call deduplication (design: docs/archive/cross-tier-llm-dedup.html).
 *
 * dev (:4101 / dev.db) and prod (:3101 / prod.db) — plus their two schedulers —
 * run the SAME code on the SAME box against the SAME data, so every LLM-backed
 * step (email parse, posting classify, …) would call Gemini twice for identical
 * input, and bill twice. This module makes Gemini get called ONCE per unique
 * input: `llmCached(req, compute)` content-hashes the request, checks a shared
 * SQLite file BOTH tiers open, and either returns a cached result, leads the
 * computation, or waits for the other tier's in-flight one.
 *
 * As of the arXiv rate-limit work (docs/arxiv-rate-limit-fix.html Layer 1, OQ8),
 * the store + single-flight protocol live in the generic base
 * `lib/shared-sqlite-cache.ts`; this module is now a thin adapter: it owns the
 * content-addressed `cacheKey` and the no-expiry semantics (a `done` row is
 * valid until pruned by age — the content hash auto-invalidates on any
 * prompt/model/schema change, so TTL is pure housekeeping). The research cache
 * (`lib/research/shared-cache.ts`) is the other adapter over the same base.
 *
 * BEST-EFFORT, NEVER load-bearing: any store failure degrades to a direct
 * uncached `compute()` (inherited from the base).
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { createSharedCache } from "@/lib/shared-sqlite-cache";

// ---------------------------------------------------------------------------
// Cache key (content-addressed — unchanged)
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
// stable sentinel rather than letting key-building throw.
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
// Store — adapter over the shared base (a third SQLite file, neither tier's DB)
// ---------------------------------------------------------------------------

const DEFAULT_CACHE_PATH = "data/llm-cache.db";

const store = createSharedCache({
    // Read the path at use time (not module-load) so a test that sets
    // LLM_CACHE_PATH then calls _resetLlmCacheForTests() picks up the change.
    resolvePath: () => process.env.LLM_CACHE_PATH ?? DEFAULT_CACHE_PATH,
    table: "llm_cache",
    label: "llm-cache",
});

export interface LlmCachedReq {
    /** Content hash from cacheKey(). */
    key: string;
    /** Callsite name (chatJSON.name) — kept for caller ergonomics/observability. */
    name: string;
    /** Resolved model id — kept for caller ergonomics/observability. */
    model: string;
}

export interface LlmCachedOpts {
    /** A pending row older than this is presumed a dead leader and stealable. */
    leaseMs?: number;
    /** A follower waits at most this long before computing itself. */
    maxWaitMs?: number;
    pollMs?: number;
}

/**
 * Call Gemini once per unique input. `compute()` is the real (rate-limited)
 * model call; it runs only when WE lead (or on a best-effort fallback). Errors
 * from `compute()` propagate untouched and are NEVER cached. Content-addressed
 * key ⇒ no TTL (the `done` row is valid until pruned by age).
 */
export function llmCached<T>(
    req: LlmCachedReq,
    compute: () => Promise<T>,
    opts?: LlmCachedOpts,
): Promise<T> {
    return store.getOrCompute<T>(req.key, compute, {
        leaseMs: opts?.leaseMs,
        maxWaitMs: opts?.maxWaitMs,
        pollMs: opts?.pollMs,
        // ttlSeconds omitted → expiry NULL → never expires (content-addressed).
    });
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
    const res = await store.prune(doneCutoff.getTime(), pendingCutoff.getTime());
    return { deleted: res.deleted, doneCutoff, pendingCutoff, disabled: res.disabled };
}

// ---------------------------------------------------------------------------
// Test seams (used by scripts/tests/hermetic/llm-cache-smoke.ts)
// ---------------------------------------------------------------------------

/** Close the current store and reset the memo so the next call re-inits (picks up a new LLM_CACHE_PATH). */
export async function _resetLlmCacheForTests(): Promise<void> {
    await store._reset();
}

export async function _statsForTests(): Promise<{ total: number; done: number; pending: number } | null> {
    return store.stats();
}

export async function _seedPendingForTests(key: string, reservedAtMs: number): Promise<boolean> {
    return store._seedPending(key, reservedAtMs);
}
