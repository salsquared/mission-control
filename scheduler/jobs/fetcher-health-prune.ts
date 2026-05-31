/**
 * Fetcher-health store housekeeping (docs/fetcher-health-store.html §7).
 *
 * The card only ever queries the last 24h, so `data/fetcher-health.db` self-
 * bounds: this sweep deletes `fetch_event` rows older than the 48h retention
 * window (one day of slack past the query window so a missed tick never
 * truncates the 1d view). At a few thousand fetches/day the table stays tiny.
 *
 * Delegates to `pruneFetcherHealth` in lib/fetcher-health/store.ts, which
 * degrades to a no-op (`disabled: true`) if the store failed to init on this
 * tier (e.g. better-sqlite3 ABI mismatch) — the store is best-effort, so the
 * prune job is too. Both schedulers run this against their own tier's rows;
 * the deletes are idempotent. Mirrors the shape of llm-cache-prune.ts.
 */
import { pruneFetcherHealth, type FetcherHealthPruneResult } from "@/lib/fetcher-health/store";

export async function runFetcherHealthPrune(): Promise<FetcherHealthPruneResult> {
    return pruneFetcherHealth();
}
