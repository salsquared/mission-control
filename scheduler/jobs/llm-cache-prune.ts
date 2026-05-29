/**
 * Cross-tier LLM dedup (docs/cross-tier-llm-dedup.html §10): bound the growth
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

export async function runLlmCachePrune(): Promise<LlmCachePruneResult> {
    return pruneLlmCache();
}
