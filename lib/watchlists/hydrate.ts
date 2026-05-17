/**
 * PB-14: When a Watchlist row carries a `directoryKey`, hydrate its config
 * from the live `COMPANY_DIRECTORY` entry instead of the stored JSON snapshot.
 *
 * This lets us correct typos / dead slugs / renamed ATSes in one place
 * (`lib/company-directory.ts`) and have existing rows pick up the fix on
 * their next read — no per-user data migration, no schema churn.
 *
 * Hydration is best-effort. If `directoryKey` points to an entry that's been
 * removed from the directory, we fall back to the stored snapshot so the
 * watchlist keeps working until the user fixes it manually.
 */
import { COMPANY_DIRECTORY } from "@/lib/company-directory";
import { WatchlistConfigSchema, type WatchlistConfig } from "@/lib/schemas/watchlists";

/**
 * Given a raw Watchlist row (storing `config` as JSON-string and a nullable
 * `directoryKey`), return the effective WatchlistConfig — directory entry if
 * available, else the parsed stored snapshot.
 *
 * Throws if both sources fail validation (caller decides how to surface).
 */
export function hydrateWatchlistConfig(row: { config: string; directoryKey: string | null }): WatchlistConfig {
    if (row.directoryKey) {
        const entry = COMPANY_DIRECTORY.find(e => e.name === row.directoryKey);
        if (entry) {
            // Trust the directory — it's typed at module load.
            return entry.config;
        }
        // Fall through: directoryKey present but entry was removed. Use the
        // stored snapshot as a graceful fallback so the row keeps running.
    }
    return WatchlistConfigSchema.parse(JSON.parse(row.config));
}

/**
 * For a freshly-submitted POST: given the client-supplied config and an
 * optional directoryKey, return the canonical config to persist + the
 * resolved directoryKey. If `directoryKey` is provided AND matches an entry,
 * its config wins (defense against a client sending stale config).
 */
export function resolveCreatePayload(
    submittedConfig: WatchlistConfig,
    directoryKey: string | null,
): { config: WatchlistConfig; directoryKey: string | null } {
    if (directoryKey) {
        const entry = COMPANY_DIRECTORY.find(e => e.name === directoryKey);
        if (entry) {
            return { config: entry.config, directoryKey };
        }
        // Key didn't resolve — caller passed a stale or invented name. Persist
        // null so future reads don't keep failing the directory lookup.
        return { config: submittedConfig, directoryKey: null };
    }
    return { config: submittedConfig, directoryKey: null };
}
