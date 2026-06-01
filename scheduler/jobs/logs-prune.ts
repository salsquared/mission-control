/**
 * Scheduler-log store housekeeping (docs/archive/scheduler-structured-logs.html §4).
 *
 * `data/logs.db` carries the scheduler's structured logs to the web tier's
 * in-app viewer. The viewer only ever queries the last ~24h, so this daily
 * sweep deletes `log_line` rows older than the 48h retention window (a day of
 * slack past the query window so a missed tick never truncates the view).
 *
 * Delegates to `pruneLogs` in lib/logs-store.ts, which degrades to a no-op
 * (`disabled: true`) if the store failed to init on this tier (e.g.
 * better-sqlite3 ABI mismatch) — the store is best-effort, so the prune is too.
 * Both schedulers run this against the shared file's rows; deletes are
 * idempotent. Mirrors fetcher-health-prune.ts.
 */
import { pruneLogs, type LogsPruneResult } from "@/lib/logs-store";

export async function runLogsPrune(): Promise<LogsPruneResult> {
    return pruneLogs();
}
