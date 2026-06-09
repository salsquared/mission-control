/**
 * Cross-tier LLM dedup (docs/archive/cross-tier-llm-dedup.html §10): bound the growth
 * of the shared `data/llm-cache.db` store.
 *
 * The cache key is content-addressed (model + rendered prompt + output schema),
 * so eviction is pure HOUSEKEEPING, never correctness — a pruned entry just
 * gets recomputed (one Gemini call) the next time that exact input recurs. We
 * sweep two classes of rows:
 *
 *   - `done` rows older than 60 days — old enough that the input is unlikely to
 *     recur; bounds disk indefinitely.
 *   - `pending` rows older than 24 hours — a leader that crashed mid-compute
 *     past any realistic lease. The reservation protocol's stale-lease steal
 *     (LEASE_MS) already handles live takeover; this just garbage-collects the
 *     tombstone so the row count doesn't drift up from crashes.
 *
 * Delegates to `pruneLlmCache` in lib/ai/llm-cache.ts, which degrades to a
 * no-op (`disabled: true`) if the store failed to initialize on this tier
 * (e.g. better-sqlite3 ABI mismatch) — the cache is best-effort, so the prune
 * job is too.
 *
 * Both schedulers (dev + prod) run this against the SAME shared file. Running
 * it twice is harmless — the deletes are idempotent. Mirrors the shape of
 * webhook-delivery-prune.ts. Exercised by scripts/tests/hermetic/llm-cache-smoke.ts.
 */
import { pruneLlmCache, type LlmCachePruneResult } from "@/lib/ai/llm-cache";
import { researchSharedStore } from "@/lib/research/shared-cache";

// The research cross-tier cache (data/research-cache.db) is a sibling adapter
// over the same shared-sqlite base (docs/archive/arxiv-rate-limit-fix.html Layer 1), so
// it's pruned here too rather than wiring a separate scheduler job. Its entries
// are short-TTL (12h/24h) and the base sweeps expired `done` rows on read; this
// just bounds disk + GCs crashed-leader `pending` tombstones. Best-effort.
const RESEARCH_DONE_RETENTION_DAYS = 7;
const RESEARCH_PENDING_RETENTION_HOURS = 24;

export async function runLlmCachePrune(): Promise<LlmCachePruneResult> {
    try {
        const now = Date.now();
        const r = await researchSharedStore.prune(
            now - RESEARCH_DONE_RETENTION_DAYS * 24 * 60 * 60 * 1000,
            now - RESEARCH_PENDING_RETENTION_HOURS * 60 * 60 * 1000,
        );
        if (!r.disabled && r.deleted > 0) console.info(`[research-cache] pruned ${r.deleted} rows`);
    } catch (e) {
        console.warn(`[research-cache] prune failed:`, e instanceof Error ? e.message : e);
    }
    return pruneLlmCache();
}
