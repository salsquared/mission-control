/**
 * PC-6 (RAH-12): token bucket rate limiter for Gemini API calls.
 * Reworked 2026-06-12 (OQ14a): the budget is now CROSS-PROCESS.
 *
 * The Gemini free tier on Google AI Studio enforces ~15 req/min on Flash.
 * A runaway "Scan inbox" backfill (or a Pub/Sub redelivery storm before
 * PB-6 closed it) can blow that quota in seconds, and Google returns 429s
 * that the SDK then surfaces as classifier failures — which under PB-5
 * meant the message was retried, which made more API calls. Hot loop.
 *
 * FOUR processes share this one box + one API key: web dev (:4101), web prod
 * (:3101), and the two schedulers. The old per-process bucket let each spend
 * the full budget independently — 4 × 12/min = a worst-case 48/min burst
 * against the ~15/min provider cap. So the PRIMARY budget is now a single
 * shared token bucket in `data/gemini-bucket.db` (gitignored; every process
 * opens the same file), each consume gated by a `BEGIN IMMEDIATE` transaction
 * so one paced line serves everyone — mirroring the arXiv shared bucket
 * (lib/arxiv/rate-limit.ts, docs/archive/arxiv-rate-limit-fix.html Layer 3).
 *
 * FALLBACK: if the shared file can't open (better-sqlite3 ABI mismatch after
 * an nvm Node switch, unwritable path, …), degrade to a per-process bucket at
 * HALF the shared rate so the multi-process sum still approximates the
 * ceiling — exactly the arXiv fallback pattern. Best-effort: the limiter
 * must never block a Gemini call outright. There is deliberately NO
 * arXiv-style cooldown/circuit-breaker layer here — that exists because
 * arXiv IP-blocks until traffic stops; Gemini 429s are per-key and transient,
 * and `chatJSON` already retries them with backoff.
 *
 * Callers `await acquireGeminiSlot()` before each API attempt (retries pay
 * the rate cost too). Tunables (env):
 *   - `GEMINI_RATE_PER_MIN` — the SHARED sustained rate across ALL processes
 *     (default 12, leaving slack below the 15/min free-tier cap so backfill +
 *     ad-hoc scans coexist). The fallback bucket runs at HALF this.
 *   - `GEMINI_RATE_BURST`   — burst headroom: the bucket banks up to one
 *     minute of unspent rate for immediate spend, and at most this many
 *     reservations may back up before acquire() rejects (default 60,
 *     ~5 minutes of work). Fail-fast beats unbounded backlog.
 */
import { openDb } from "@/lib/shared-sqlite-cache";
import { clampInt, createProcessBucket } from "@/lib/rate-limit/process-bucket";

const RATE_PER_MIN = clampInt(process.env.GEMINI_RATE_PER_MIN, 12, 1, 600);
const BURST_CAP = clampInt(process.env.GEMINI_RATE_BURST, 60, 1, 10_000);
const REFILL_INTERVAL_MS = 60_000 / RATE_PER_MIN;

// Per-process FALLBACK runs at half the shared rate, so dev+prod (+schedulers)
// combined still ~approximate the shared ceiling when the file is unavailable.
const FALLBACK_RATE_PER_MIN = Math.max(1, Math.round(RATE_PER_MIN / 2));

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// PRIMARY — shared-file token bucket (one paced line for every process)
// ---------------------------------------------------------------------------

const BUCKET_DEFAULT_PATH = "data/gemini-bucket.db";

/** A consume fn: given `now` (ms), returns the ms the caller must sleep before
 *  its slot (0 = go immediately). Throws if the reservation backlog is full. */
interface SharedBucketHandle {
    consume: (now: number) => number;
}

async function initSharedBucketAt(path: string): Promise<SharedBucketHandle | null> {
    const db = await openDb(path);
    if (!db) return null;
    try {
        db.exec(
            `CREATE TABLE IF NOT EXISTS gemini_bucket (
                id          INTEGER PRIMARY KEY CHECK (id = 1),
                tokens      REAL NOT NULL,
                last_refill INTEGER NOT NULL
            );`,
        );
        // Seed last_refill = 0 so the first consume sees a huge elapsed and caps
        // at RATE_PER_MIN tokens — i.e. the bucket starts full (first burst
        // doesn't queue), for both real-clock and synthetic `now`.
        db.prepare(`INSERT OR IGNORE INTO gemini_bucket (id, tokens, last_refill) VALUES (1, ?, 0)`).run(
            RATE_PER_MIN,
        );

        const sel = db.prepare(`SELECT tokens, last_refill FROM gemini_bucket WHERE id = 1`);
        const upd = db.prepare(`UPDATE gemini_bucket SET tokens = ?, last_refill = ? WHERE id = 1`);

        // Atomic refill → consume under a cross-process write lock (BEGIN
        // IMMEDIATE). Tokens cap at RATE_PER_MIN (the bucket banks up to a
        // minute of unspent rate — preserves the old start-full burst). A miss
        // reserves a future slot by letting tokens go negative; the next caller
        // therefore computes a later slot, fanning callers out
        // REFILL_INTERVAL_MS apart.
        const consumeTxn = db.transaction((now: number): number => {
            const row = sel.get() as { tokens: number; last_refill: number } | undefined;
            const prevTokens = row ? row.tokens : RATE_PER_MIN;
            const lastRefill = row ? row.last_refill : 0;
            const elapsed = Math.max(0, now - lastRefill);
            let tokens = Math.min(RATE_PER_MIN, prevTokens + (elapsed / 60_000) * RATE_PER_MIN);
            let waitMs = 0;
            if (tokens < 1) {
                const deficit = 1 - tokens;
                if (deficit > BURST_CAP) {
                    throw new Error(
                        `Gemini shared rate-limit backlog at capacity (${BURST_CAP}). Slow the caller or raise GEMINI_RATE_BURST.`,
                    );
                }
                waitMs = Math.ceil(deficit * REFILL_INTERVAL_MS);
            }
            tokens -= 1; // consume (may go negative = future reservation)
            upd.run(tokens, now);
            return waitMs;
        });

        console.info(`[gemini-bucket] ready at ${path} (shared, ${RATE_PER_MIN}/min, burst ${BURST_CAP})`);
        // `.immediate` ⇒ BEGIN IMMEDIATE: acquire the write lock upfront so two
        // processes can't both read-then-write the row and double-grant a slot.
        return { consume: (now: number) => consumeTxn.immediate(now) as number };
    } catch (e) {
        console.warn(`[gemini-bucket] disabled — falling back to per-process:`, e instanceof Error ? e.message : e);
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
        const path = process.env.GEMINI_BUCKET_PATH ?? BUCKET_DEFAULT_PATH;
        bucketPromise = initSharedBucketAt(path);
    }
    return bucketPromise;
}

// ---------------------------------------------------------------------------
// FALLBACK — per-process bucket (half rate; used only when the shared file is down)
// ---------------------------------------------------------------------------

const fallbackBucket = createProcessBucket({
    ratePerMin: FALLBACK_RATE_PER_MIN,
    maxTokens: FALLBACK_RATE_PER_MIN, // start full / bursty, like the old per-process bucket
    burstCap: BURST_CAP,
    label: "Gemini",
    envHint: "GEMINI_RATE_BURST",
    globalKey: "__mcGeminiRateBucket",
});

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Block until one token is available on the SHARED cross-process bucket
 * (sleeping until the reserved slot when the line is backed up). Throws when
 * the reservation backlog is already at the burst cap — fail-fast instead of
 * accumulating unbounded request backlog. Degrades to the per-process
 * half-rate bucket on any shared-store failure.
 */
export async function acquireGeminiSlot(): Promise<void> {
    let handle: SharedBucketHandle | null = null;
    try {
        handle = await getSharedBucket();
    } catch {
        handle = null;
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
            console.warn(`[gemini-bucket] acquire failed, using per-process bucket:`, e instanceof Error ? e.message : e);
        }
    }
    return fallbackBucket.acquire();
}

/** Test/debug introspection. Not used in production code paths. `tokens` /
 *  `queued` describe the per-process FALLBACK bucket (the shared bucket's
 *  state lives in the SQLite file); `rate` is the configured SHARED rate. */
export function geminiBucketSnapshot() {
    const s = fallbackBucket.snapshot();
    return {
        tokens: s.tokens,
        queued: s.queued,
        rate: RATE_PER_MIN,
        fallbackRate: FALLBACK_RATE_PER_MIN,
        burst: BURST_CAP,
    };
}

/**
 * Test-only: wipe the per-process fallback bucket back to defaults. Used by
 * the hermetic smokes to start each scenario from a clean state.
 */
export function _resetGeminiBucketForTests() {
    fallbackBucket.reset();
}

// --- Test seams (scripts/tests/hermetic/gemini-shared-bucket-smoke.ts) ---

/** Build an independent shared-bucket handle at `path` (simulates a second
 *  process opening the same file). Returns null if the file can't open. */
export function _createSharedGeminiBucketForTests(path: string): Promise<SharedBucketHandle | null> {
    return initSharedBucketAt(path);
}

/** Drop the memoized singleton so the next acquire re-reads GEMINI_BUCKET_PATH.
 *  Lets a hermetic test flip between a working and an unopenable shared file. */
export function _resetSharedGeminiBucketForTests() {
    bucketPromise = null;
}
