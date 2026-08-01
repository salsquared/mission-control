/**
 * Active-satellite count history — the series behind the Active Sats sparkline.
 *
 * A CROSS-TIER sidecar: dev (:4101) and prod (:3101) open one shared
 * data/satellite-counts.db, the same cross-process better-sqlite3 pattern as
 * lib/fetcher-health/store.ts and lib/logs-store.ts. Shared rather than per-tier
 * (no `tier` column) because the count is a fact about the world, not about a
 * tier — one series means the dev dash charts real data from day one and the two
 * tiers can never disagree about how many satellites were up on a given date.
 *
 * Why not a Prisma table: dev.db and prod.db would accumulate two divergent
 * copies of that same global fact, and lib/prisma.ts logs every query in prod.
 *
 * UNLIKE every other sidecar under data/, this one is NOT throwaway and has NO
 * prune job. Celestrak serves only CURRENT elements, so a day we fail to record
 * can never be back-filled from anywhere — the file is retained in full and is
 * copied by scripts/backup-db.sh alongside prod.db.
 *
 * Best-effort on the WRITE path: a store failure must never break the satellites
 * route, so recording swallows everything. The READ path degrades honestly — a
 * failed read returns [] and the card renders its "collecting" state instead of
 * a chart, rather than inventing a series.
 */
import { resolve as resolvePath } from "node:path";
import { utcDateBucket } from "@/lib/notifications/dispatch";

/** One observation of Celestrak's GROUP=active list. */
export interface SatelliteSample {
    total: number;
    orbits?: { LEO?: number; MEO?: number; GEO?: number; SSO?: number; other?: number };
    constellations?: { starlink?: number; oneweb?: number };
}

/**
 * One day of the series, as served to the client. The orbit splits partition the
 * total — the route classifies every satellite into exactly one bucket — so they
 * sum back to `total` and can be stacked against it. Rows written before a bucket
 * existed, or from a malformed sample, read as 0 rather than null (COALESCE at
 * the query) so a chart never has to special-case a gap.
 */
export interface SatelliteCountPoint {
    /** UTC calendar day, YYYY-MM-DD. */
    date: string;
    total: number;
    leo: number;
    meo: number;
    geo: number;
    sso: number;
    other: number;
}

const DEFAULT_PATH = "data/satellite-counts.db";

/** How much history the card asks for by default. */
export const DEFAULT_HISTORY_DAYS = 90;

interface Store {
    upsert(row: {
        date: string;
        recordedAt: number;
        total: number;
        leo: number | null;
        meo: number | null;
        geo: number | null;
        sso: number | null;
        other: number | null;
        starlink: number | null;
        oneweb: number | null;
    }): void;
    read(sinceDate: string): SatelliteCountPoint[];
    count(): number;
    close(): void;
}

// `undefined` until init settles, then a `Store` or `null` (disabled). The
// PROMISE is memoized so concurrent first-callers share one init.
let storePromise: Promise<Store | null> | null = null;

async function initStore(): Promise<Store | null> {
    // Read the path at init time (not module-load) so a test can point this at
    // a scratch file and reset it between cases.
    const relOrAbs = process.env.SATELLITE_COUNTS_PATH ?? DEFAULT_PATH;
    const abs = resolvePath(process.cwd(), relOrAbs);
    try {
        // Guarded dynamic import (repo convention for externalized native deps).
        // An ABI-mismatch load failure REJECTS here and is caught below,
        // degrading to a no-op recorder rather than throwing at module-init.
        const mod = await import("better-sqlite3");
        const Database = mod.default;
        const db = new Database(abs);
        db.pragma("journal_mode = WAL"); // both tiers read; either may write
        db.pragma("busy_timeout = 5000"); // brief cross-process write contention waits, doesn't throw
        // FULL, not NORMAL: unlike the telemetry sidecars this data is
        // unrecoverable if a crash loses the write, and it's one row per day.
        db.pragma("synchronous = FULL");
        db.exec(`
            CREATE TABLE IF NOT EXISTS satellite_count (
                date        TEXT    PRIMARY KEY,
                recorded_at INTEGER NOT NULL,
                total       INTEGER NOT NULL,
                leo         INTEGER,
                meo         INTEGER,
                geo         INTEGER,
                sso         INTEGER,
                other       INTEGER,
                starlink    INTEGER,
                oneweb      INTEGER
            );
        `);

        // One row per UTC day, last observation of the day wins — the closing
        // count is the truest daily figure, and re-running is idempotent.
        const upsertStmt = db.prepare(`
            INSERT INTO satellite_count
                (date, recorded_at, total, leo, meo, geo, sso, other, starlink, oneweb)
            VALUES
                (@date, @recordedAt, @total, @leo, @meo, @geo, @sso, @other, @starlink, @oneweb)
            ON CONFLICT(date) DO UPDATE SET
                recorded_at = excluded.recorded_at,
                total       = excluded.total,
                leo         = excluded.leo,
                meo         = excluded.meo,
                geo         = excluded.geo,
                sso         = excluded.sso,
                other       = excluded.other,
                starlink    = excluded.starlink,
                oneweb      = excluded.oneweb
        `);
        const readStmt = db.prepare(`
            SELECT date,
                   total,
                   COALESCE(leo,   0) AS leo,
                   COALESCE(meo,   0) AS meo,
                   COALESCE(geo,   0) AS geo,
                   COALESCE(sso,   0) AS sso,
                   COALESCE(other, 0) AS other
              FROM satellite_count
             WHERE date >= ?
          ORDER BY date ASC
        `);
        const countStmt = db.prepare(`SELECT COUNT(*) AS total FROM satellite_count`);

        console.info(`[satellite-counts] store ready at ${abs} (WAL)`);

        return {
            upsert: (row) => {
                upsertStmt.run(row);
            },
            read: (sinceDate) => readStmt.all(sinceDate) as SatelliteCountPoint[],
            count: () => {
                const r = countStmt.get() as { total: number | null };
                return Number(r.total ?? 0);
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
            `[satellite-counts] disabled — store init failed; counts will NOT be recorded:`,
            e instanceof Error ? e.message : e,
        );
        return null;
    }
}

function ensureStore(): Promise<Store | null> {
    if (!storePromise) {
        storePromise = initStore().catch(() => null);
    }
    return storePromise;
}

const intOrNull = (v: number | undefined): number | null =>
    typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null;

/**
 * Record today's observation. Awaited by the route so the fresh point shows up
 * in the very next history read, but it never throws and never rejects — a
 * broken sidecar must not turn a good Celestrak response into a 500.
 *
 * The orbit and constellation splits ride along in the same row even though only
 * `total` is charted today: they cost nothing to store and, unlike a value we
 * can re-derive, a day that goes by unrecorded is gone for good.
 */
export async function recordSatelliteCount(
    sample: SatelliteSample,
    now: Date = new Date(),
): Promise<void> {
    try {
        if (!Number.isFinite(sample?.total) || sample.total <= 0) return;
        const store = await ensureStore();
        store?.upsert({
            date: utcDateBucket(now),
            recordedAt: now.getTime(),
            total: Math.trunc(sample.total),
            leo: intOrNull(sample.orbits?.LEO),
            meo: intOrNull(sample.orbits?.MEO),
            geo: intOrNull(sample.orbits?.GEO),
            sso: intOrNull(sample.orbits?.SSO),
            other: intOrNull(sample.orbits?.other),
            starlink: intOrNull(sample.constellations?.starlink),
            oneweb: intOrNull(sample.constellations?.oneweb),
        });
    } catch (e) {
        console.warn(
            "[satellite-counts] record failed (ignored):",
            e instanceof Error ? e.message : e,
        );
    }
}

/** The last `days` days of the series, oldest first. `[]` if unavailable. */
export async function readSatelliteCountHistory(
    days: number = DEFAULT_HISTORY_DAYS,
    now: Date = new Date(),
): Promise<SatelliteCountPoint[]> {
    try {
        const store = await ensureStore();
        if (!store) return [];
        const since = new Date(now.getTime() - Math.max(1, days) * 24 * 60 * 60 * 1000);
        return store.read(utcDateBucket(since));
    } catch (e) {
        console.warn(
            "[satellite-counts] read failed (serving empty history):",
            e instanceof Error ? e.message : e,
        );
        return [];
    }
}

/** Row count — for smokes and the /api/system readout. */
export async function satelliteCountStats(): Promise<{ days: number }> {
    try {
        const store = await ensureStore();
        return { days: store?.count() ?? 0 };
    } catch {
        return { days: 0 };
    }
}

/** Test seam: drop the memoized handle so the next call re-reads the env path. */
export async function __resetSatelliteCountStore(): Promise<void> {
    const pending = storePromise;
    storePromise = null;
    try {
        (await pending)?.close();
    } catch {
        /* best-effort */
    }
}
