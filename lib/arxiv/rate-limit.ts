/**
 * Token-bucket rate limiter for arXiv API calls.
 *
 * arXiv's documented soft policy is "no more than one request every three
 * seconds." Tripping it returns HTTP 429 "Rate exceeded." (or worse, 200
 * with the same plaintext body), which then propagates as empty cards. The
 * research/review and research/historical routes both hit arXiv, and AIView
 * fires them in parallel on mount — without coordination, the second call
 * almost always 429s.
 *
 * This bucket gates every arXiv fetch in the app: callers
 * `await acquireArxivSlot()` before each `fetch(...)`. Process-local; one
 * Next.js worker + the scheduler share their own buckets (scheduler doesn't
 * call arXiv today, so this is effectively per-app).
 *
 * Defaults are conservative on purpose — being slightly slower than the
 * documented policy buys headroom for browser caches busting + concurrent
 * dashboards. Tune via env if needed:
 *   - `ARXIV_RATE_PER_MIN`  — sustained rate (default 15 = one per 4s).
 *   - `ARXIV_RATE_BURST`    — max queued requests waiting in line (default 20).
 */

const RATE_PER_MIN = clampInt(process.env.ARXIV_RATE_PER_MIN, 15, 1, 600);
const BURST_CAP = clampInt(process.env.ARXIV_RATE_BURST, 20, 1, 10_000);
const REFILL_INTERVAL_MS = 60_000 / RATE_PER_MIN;

interface BucketState {
    tokens: number;
    lastRefillAt: number;
    queue: Array<() => void>;
}

const KEY = "__mcArxivRateBucket";
const g = globalThis as unknown as { [KEY]?: BucketState };
function bucket(): BucketState {
    if (!g[KEY]) {
        g[KEY] = {
            tokens: 1, // start with a single token — first call goes through, subsequent ones space out
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
        }, REFILL_INTERVAL_MS);
    }
}

export async function acquireArxivSlot(): Promise<void> {
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
