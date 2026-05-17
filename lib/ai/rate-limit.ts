/**
 * PC-6 (RAH-12): token bucket rate limiter for Gemini API calls.
 *
 * The Gemini free tier on Google AI Studio enforces ~15 req/min on Flash.
 * A runaway "Scan inbox" backfill (or a Pub/Sub redelivery storm before
 * PB-6 closed it) can blow that quota in seconds, and Google returns 429s
 * that the SDK then surfaces as classifier failures — which under PB-5
 * meant the message was retried, which made more API calls. Hot loop.
 *
 * This module enforces a per-process rate budget BEFORE the API call lands.
 * Callers `await acquireGeminiSlot()` to block until a token is available.
 *
 * Bucket sizing comes from env vars (defaults conservative — Google's free
 * tier limit):
 *   - `GEMINI_RATE_PER_MIN`  — sustained rate (default 12, leaving slack
 *     below the 15/min free-tier cap so backfill + ad-hoc scans coexist).
 *   - `GEMINI_RATE_BURST`    — max queued requests waiting in line
 *     (default 60, ~5 minutes of work).
 *
 * Process-local. A multi-process deployment would need a shared counter
 * (Redis); mission-control runs one Next.js process + one scheduler, both
 * of which classify emails, so there's mild over-budgeting under load. The
 * defaults stay comfortably under the cap even at 2x.
 */

const RATE_PER_MIN = clampInt(process.env.GEMINI_RATE_PER_MIN, 12, 1, 600);
const BURST_CAP = clampInt(process.env.GEMINI_RATE_BURST, 60, 1, 10_000);
const REFILL_INTERVAL_MS = 60_000 / RATE_PER_MIN;

interface BucketState {
    tokens: number;
    lastRefillAt: number;
    queue: Array<() => void>;
}

// Stash on globalThis so HMR + repeated module imports share one bucket.
const KEY = "__mcGeminiRateBucket";
const g = globalThis as unknown as { [KEY]?: BucketState };
function bucket(): BucketState {
    if (!g[KEY]) {
        g[KEY] = {
            tokens: RATE_PER_MIN, // start full so the first burst doesn't queue
            lastRefillAt: Date.now(),
            queue: [],
        };
    }
    return g[KEY]!;
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
    if (!raw) return fallback;
    const n = parseInt(raw, 10);
    if (Number.isNaN(n)) return fallback;
    return Math.max(min, Math.min(max, n));
}

function refill(b: BucketState, now: number) {
    const elapsed = now - b.lastRefillAt;
    if (elapsed <= 0) return;
    const added = (elapsed / 60_000) * RATE_PER_MIN;
    b.tokens = Math.min(RATE_PER_MIN, b.tokens + added);
    b.lastRefillAt = now;
}

function drainQueue(b: BucketState) {
    while (b.queue.length > 0 && b.tokens >= 1) {
        b.tokens -= 1;
        const next = b.queue.shift()!;
        next();
    }
    if (b.queue.length > 0) {
        // Schedule another drain when the next token is due.
        setTimeout(() => {
            refill(bucket(), Date.now());
            drainQueue(bucket());
        }, REFILL_INTERVAL_MS);
    }
}

/**
 * Block until one token is available. Throws if the queue is already at the
 * burst cap — fail-fast instead of accumulating unbounded request backlog.
 */
export async function acquireGeminiSlot(): Promise<void> {
    const b = bucket();
    refill(b, Date.now());
    if (b.tokens >= 1 && b.queue.length === 0) {
        b.tokens -= 1;
        return;
    }
    if (b.queue.length >= BURST_CAP) {
        throw new Error(
            `Gemini rate-limit queue at capacity (${BURST_CAP}). Slow the caller or raise GEMINI_RATE_BURST.`,
        );
    }
    await new Promise<void>((resolve) => {
        b.queue.push(resolve);
        // Kick a drain pass — refill timer may not be scheduled yet.
        drainQueue(b);
    });
}

/** Test/debug introspection. Not used in production code paths. */
export function geminiBucketSnapshot() {
    const b = bucket();
    refill(b, Date.now());
    return { tokens: b.tokens, queued: b.queue.length, rate: RATE_PER_MIN, burst: BURST_CAP };
}

/**
 * Test-only: wipe the bucket back to defaults. Used by the hermetic smoke
 * to start each scenario from a clean state.
 */
export function _resetGeminiBucketForTests() {
    g[KEY] = undefined;
}
