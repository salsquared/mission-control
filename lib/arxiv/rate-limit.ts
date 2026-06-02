/**
 * Token-bucket rate limiter for arXiv API calls.
 *
 * arXiv's documented soft policy is ~one request every three seconds. Over the
 * limit it returns HTTP 429 "Rate exceeded." (or worse, a 200 with that same
 * plaintext body), which propagates as empty cards. dev (:4101) and prod (:3101)
 * — plus both schedulers — share ONE IP, so the rate must be coordinated ACROSS
 * processes; a per-process bucket lets the two tiers burst-collide on the IP
 * even when each is individually under the limit.
 *
 * PRIMARY: a single shared token bucket in `data/arxiv-bucket.db` (both tiers +
 * schedulers open it), each consume gated by a `BEGIN IMMEDIATE` transaction so
 * one paced line serves everyone (docs/arxiv-rate-limit-fix.html Layer 3,
 * OQ4/OQ9 — reuses the shared-base `openDb()` seam, keeps its own single-row
 * table + transaction logic rather than the keyed-store shape).
 *
 * FALLBACK: if the shared file can't open (better-sqlite3 ABI mismatch, an
 * unwritable path, …), degrade to a per-process `globalThis` bucket at HALF the
 * rate, so the two-tier sum still ~approximates the ceiling. Best-effort — the
 * limiter must never block an arXiv call outright.
 *
 * CIRCUIT BREAKER (recovery layer). Pacing alone can't recover once arXiv has
 * already flagged the shared IP: it then 429s EVERY request, so a route 500s,
 * nothing caches, the next dash load re-fires the search, and arXiv's throttle
 * window keeps resetting — the block never clears. `noteArxivRateLimited()`
 * records a cross-tier cooldown (in the same shared file) on any observed 429 /
 * "Rate exceeded"; while it's active `acquireArxivSlot()` throws
 * `ArxivRateLimitCooldownError` WITHOUT touching arXiv, so BOTH tiers go quiet
 * long enough for the IP block to expire. One probe runs after the window; if
 * still blocked it re-arms. Cooldown lives next to the bucket (shared row +
 * per-process fallback var), best-effort like everything else here.
 *
 * Tunables (env):
 *   - `ARXIV_RATE_PER_MIN` — the SHARED sustained rate (one paced line across
 *     all processes). Set ~14 (under arXiv's ~20/min = 1-per-3s). Default 14.
 *   - `ARXIV_RATE_BURST`   — max reservations backed up before acquire rejects.
 *   - `ARXIV_COOLDOWN_MS`  — how long to stop ALL arXiv calls after a 429.
 *     Default 900000 (15 min) — far longer than any arXiv throttle window, so
 *     the block reliably clears; picks are weekly + DB-cached so the lag is moot.
 */
import { openDb } from "@/lib/shared-sqlite-cache";
import { ArxivRateLimitCooldownError } from "@/lib/arxiv/errors";

const RATE_PER_MIN = clampInt(process.env.ARXIV_RATE_PER_MIN, 14, 1, 600);
const BURST_CAP = clampInt(process.env.ARXIV_RATE_BURST, 20, 1, 10_000);
const REFILL_INTERVAL_MS = 60_000 / RATE_PER_MIN;

// Cross-tier cooldown after an observed 429. Default 15 min (see header).
const COOLDOWN_MS = clampInt(process.env.ARXIV_COOLDOWN_MS, 900_000, 1_000, 3_600_000);

// Per-process FALLBACK runs at half the shared rate, so dev+prod combined still
// ~approximates the shared ceiling when the shared file is unavailable on both.
const FALLBACK_RATE_PER_MIN = Math.max(1, Math.round(RATE_PER_MIN / 2));
const FALLBACK_REFILL_INTERVAL_MS = 60_000 / FALLBACK_RATE_PER_MIN;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
    if (!raw) return fallback;
    const n = parseInt(raw, 10);
    if (Number.isNaN(n)) return fallback;
    return Math.max(min, Math.min(max, n));
}

// ---------------------------------------------------------------------------
// PRIMARY — shared-file token bucket (one paced line for every process)
// ---------------------------------------------------------------------------

const BUCKET_DEFAULT_PATH = "data/arxiv-bucket.db";

/** A consume fn: given `now` (ms), returns the ms the caller must sleep before
 *  its slot (0 = go immediately). Throws if the reservation backlog is full. */
type Consume = (now: number) => number;

/** A bucket handle bundles the paced-consume fn with the cross-tier cooldown
 *  row (same shared file). All methods are synchronous (better-sqlite3). */
interface SharedBucketHandle {
    consume: Consume;
    /** ms epoch the cooldown lasts until; 0 (or past) = no cooldown active. */
    getCooldownUntil: () => number;
    /** Extend the cooldown to at least `until` (MAX in SQL — race-safe across
     *  processes; never shortens an existing, longer cooldown). */
    bumpCooldownUntil: (until: number) => void;
    /** Hard-clear the cooldown (test/reset seam only). */
    clearCooldown: () => void;
}

async function initSharedBucketAt(path: string): Promise<SharedBucketHandle | null> {
    const db = await openDb(path);
    if (!db) return null;
    try {
        db.exec(
            `CREATE TABLE IF NOT EXISTS arxiv_bucket (
                id          INTEGER PRIMARY KEY CHECK (id = 1),
                tokens      REAL NOT NULL,
                last_refill INTEGER NOT NULL
            );`,
        );
        // Seed last_refill = 0 so the first consume sees a huge elapsed and just
        // caps at 1 token (works for both real-clock and synthetic `now`).
        db.prepare(`INSERT OR IGNORE INTO arxiv_bucket (id, tokens, last_refill) VALUES (1, 1, 0)`).run();

        // Cooldown row (circuit breaker) lives in the SAME file so both tiers see
        // one trip. Separate single-row table — no ALTER of the bucket table.
        db.exec(
            `CREATE TABLE IF NOT EXISTS arxiv_cooldown (
                id    INTEGER PRIMARY KEY CHECK (id = 1),
                until INTEGER NOT NULL
            );`,
        );
        db.prepare(`INSERT OR IGNORE INTO arxiv_cooldown (id, until) VALUES (1, 0)`).run();
        const selCd = db.prepare(`SELECT until FROM arxiv_cooldown WHERE id = 1`);
        const bumpCd = db.prepare(`UPDATE arxiv_cooldown SET until = MAX(until, ?) WHERE id = 1`);
        const clearCd = db.prepare(`UPDATE arxiv_cooldown SET until = 0 WHERE id = 1`);

        const sel = db.prepare(`SELECT tokens, last_refill FROM arxiv_bucket WHERE id = 1`);
        const upd = db.prepare(`UPDATE arxiv_bucket SET tokens = ?, last_refill = ? WHERE id = 1`);

        // Atomic refill → consume under a cross-process write lock (BEGIN
        // IMMEDIATE). Tokens cap at 1 (no burst — strict pacing). A miss reserves
        // a future slot by letting tokens go negative; the next caller therefore
        // computes a later slot, so callers fan out REFILL_INTERVAL_MS apart.
        const consumeTxn = db.transaction((now: number): number => {
            const row = sel.get() as { tokens: number; last_refill: number } | undefined;
            const prevTokens = row ? row.tokens : 1;
            const lastRefill = row ? row.last_refill : 0;
            const elapsed = Math.max(0, now - lastRefill);
            let tokens = Math.min(1, prevTokens + (elapsed / 60_000) * RATE_PER_MIN);
            let waitMs = 0;
            if (tokens < 1) {
                const deficit = 1 - tokens;
                if (deficit > BURST_CAP) {
                    throw new Error(
                        `arXiv shared rate-limit backlog at capacity (${BURST_CAP}). Slow the caller or raise ARXIV_RATE_BURST.`,
                    );
                }
                waitMs = Math.ceil(deficit * REFILL_INTERVAL_MS);
            }
            tokens -= 1; // consume (may go negative = future reservation)
            upd.run(tokens, now);
            return waitMs;
        });

        console.info(`[arxiv-bucket] ready at ${path} (shared, ${RATE_PER_MIN}/min, cooldown ${Math.round(COOLDOWN_MS / 1000)}s)`);
        // `.immediate` ⇒ BEGIN IMMEDIATE: acquire the write lock upfront so two
        // processes can't both read-then-write the row and double-grant a slot.
        return {
            consume: (now: number) => consumeTxn.immediate(now) as number,
            getCooldownUntil: () => {
                const r = selCd.get() as { until: number } | undefined;
                return r ? r.until : 0;
            },
            bumpCooldownUntil: (until: number) => {
                bumpCd.run(until);
            },
            clearCooldown: () => {
                clearCd.run();
            },
        };
    } catch (e) {
        console.warn(`[arxiv-bucket] disabled — falling back to per-process:`, e instanceof Error ? e.message : e);
        try {
            db.close();
        } catch {
            /* best-effort */
        }
        return null;
    }
}

let bucketPromise: Promise<SharedBucketHandle | null> | null = null;
function getSharedBucket(): Promise<SharedBucketHandle | null> {
    if (!bucketPromise) {
        const path = process.env.ARXIV_BUCKET_PATH ?? BUCKET_DEFAULT_PATH;
        bucketPromise = initSharedBucketAt(path);
    }
    return bucketPromise;
}

// Per-process cooldown fallback (mirrors the shared row when the file is down,
// and shadows it so a trip is honored even before the shared write lands).
const COOLDOWN_KEY = "__mcArxivCooldownUntil";
const cg = globalThis as unknown as { [COOLDOWN_KEY]?: number };
function perProcCooldownUntil(): number {
    return cg[COOLDOWN_KEY] ?? 0;
}
function bumpPerProcCooldown(until: number): void {
    cg[COOLDOWN_KEY] = Math.max(perProcCooldownUntil(), until);
}

// ---------------------------------------------------------------------------
// FALLBACK — per-process globalThis bucket (half rate; used only if shared down)
// ---------------------------------------------------------------------------

interface BucketState {
    tokens: number;
    lastRefillAt: number;
    queue: Array<() => void>;
}

const KEY = "__mcArxivRateBucket";
const g = globalThis as unknown as { [KEY]?: BucketState };
function bucket(): BucketState {
    if (!g[KEY]) {
        g[KEY] = { tokens: 1, lastRefillAt: Date.now(), queue: [] };
    }
    return g[KEY]!;
}

function refill(b: BucketState, now: number) {
    const elapsed = now - b.lastRefillAt;
    if (elapsed <= 0) return;
    const added = (elapsed / 60_000) * FALLBACK_RATE_PER_MIN;
    b.tokens = Math.min(1, b.tokens + added); // cap at 1 — no burst, strict pacing
    b.lastRefillAt = now;
}

function drainQueue(b: BucketState) {
    while (b.queue.length > 0 && b.tokens >= 1) {
        b.tokens -= 1;
        const next = b.queue.shift()!;
        next();
    }
    if (b.queue.length > 0) {
        setTimeout(() => {
            refill(bucket(), Date.now());
            drainQueue(bucket());
        }, FALLBACK_REFILL_INTERVAL_MS);
    }
}

async function acquirePerProcessSlot(): Promise<void> {
    const b = bucket();
    refill(b, Date.now());
    if (b.tokens >= 1 && b.queue.length === 0) {
        b.tokens -= 1;
        return;
    }
    if (b.queue.length >= BURST_CAP) {
        throw new Error(
            `arXiv rate-limit queue at capacity (${BURST_CAP}). Slow the caller or raise ARXIV_RATE_BURST.`,
        );
    }
    await new Promise<void>((resolve) => {
        b.queue.push(resolve);
        drainQueue(b);
    });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function acquireArxivSlot(): Promise<void> {
    let handle: SharedBucketHandle | null = null;
    try {
        handle = await getSharedBucket();
    } catch {
        handle = null;
    }

    // Circuit breaker: if a recent 429 tripped the cooldown, fast-fail WITHOUT
    // touching arXiv so the IP-level block can clear. Honor whichever of the
    // shared row / per-process var is further out.
    let cooldownUntil = perProcCooldownUntil();
    if (handle) {
        try {
            cooldownUntil = Math.max(cooldownUntil, handle.getCooldownUntil());
        } catch {
            /* best-effort */
        }
    }
    if (Date.now() < cooldownUntil) {
        throw new ArxivRateLimitCooldownError(Math.ceil((cooldownUntil - Date.now()) / 1000));
    }

    if (handle) {
        try {
            const waitMs = handle.consume(Date.now());
            if (waitMs > 0) await sleep(waitMs);
            return;
        } catch (e) {
            // A backlog rejection is a real caller-facing condition (mirrors the
            // per-process queue-cap throw) — propagate it. Any other error is a
            // store failure → degrade to the per-process bucket for this call.
            if (e instanceof Error && e.message.includes("backlog at capacity")) throw e;
            console.warn(`[arxiv-bucket] acquire failed, using per-process bucket:`, e instanceof Error ? e.message : e);
        }
    }
    return acquirePerProcessSlot();
}

/**
 * Trip the cross-tier cooldown after an observed arXiv rate-limit (429 or a
 * plaintext "Rate exceeded." 200). Best-effort and idempotent: writes the
 * shared row (so the OTHER tier honors it too) and the per-process var (so it's
 * honored even if the shared write fails). Never throws.
 */
export async function noteArxivRateLimited(durationMs: number = COOLDOWN_MS): Promise<void> {
    const until = Date.now() + Math.max(0, durationMs);
    bumpPerProcCooldown(until);
    try {
        const handle = await getSharedBucket();
        handle?.bumpCooldownUntil(until);
    } catch {
        /* best-effort — the per-process var still guards this process */
    }
}

// --- Test seams (scripts/tests/hermetic/arxiv-shared-bucket-smoke.ts) ---
/** Build an independent shared-bucket handle at `path` (simulates a second tier
 *  opening the same file). Returns null if the file can't open. */
export function _createSharedBucketForTests(path: string): Promise<SharedBucketHandle | null> {
    return initSharedBucketAt(path);
}

/** Hard-clear the cooldown (both the singleton shared row and the per-process
 *  var) so a hermetic test can return to the no-cooldown baseline. */
export async function _resetCooldownForTests(): Promise<void> {
    cg[COOLDOWN_KEY] = 0;
    try {
        const handle = await getSharedBucket();
        handle?.clearCooldown();
    } catch {
        /* best-effort */
    }
}
