/**
 * Generic PER-PROCESS token-bucket rate limiter.
 *
 * Extracted (2026-06-12, OQ14a) from the near-verbatim twins in
 * lib/ai/rate-limit.ts (Gemini) and the per-process FALLBACK half of
 * lib/arxiv/rate-limit.ts — one implementation, parameterized. This module is
 * the per-process primitive ONLY: the cross-process shared-file buckets
 * (`BEGIN IMMEDIATE` consume over data/{arxiv,gemini}-bucket.db) stay in their
 * own modules and degrade to a bucket built from this factory when the shared
 * file is unavailable.
 *
 * Semantics (unchanged from the originals):
 *   - Tokens refill continuously at `ratePerMin`, capped at `maxTokens`.
 *     `maxTokens = ratePerMin` ⇒ the bursty "start full" Gemini shape;
 *     `maxTokens = 1` ⇒ the strict-pacing arXiv shape (no burst).
 *   - `acquire()` resolves immediately when a token is free and nobody is
 *     queued; otherwise it joins a FIFO queue drained one token per refill
 *     interval.
 *   - A queue already at `burstCap` rejects — fail-fast instead of
 *     accumulating unbounded request backlog.
 *   - State stashes on `globalThis` under `globalKey` so HMR + repeated module
 *     imports share ONE bucket per process.
 *
 * Fix folded in during extraction (the "stacked drain timer" wart): the
 * originals scheduled a NEW `setTimeout` drain pass from every queued
 * `acquire()` while earlier timers were still pending — N waiters could stack
 * up to N redundant timers, each refilling + draining the same bucket. The
 * bucket now tracks its pending timer and schedules at most one at a time.
 */

export interface ProcessBucketConfig {
    /** Sustained refill rate, tokens per minute. */
    ratePerMin: number;
    /** Token cap (burst headroom). 1 = strict pacing; ratePerMin = start-full bursty. */
    maxTokens: number;
    /** Max queued waiters before acquire() rejects. */
    burstCap: number;
    /** Human label for the rejection message, e.g. "Gemini". */
    label: string;
    /** Env var named in the rejection message, e.g. "GEMINI_RATE_BURST". */
    envHint: string;
    /** globalThis stash key — keep unique per logical bucket, e.g. "__mcGeminiRateBucket". */
    globalKey: string;
}

export interface ProcessBucket {
    /** Block until one token is available. Rejects when the queue is at burstCap. */
    acquire(): Promise<void>;
    /** Test/debug introspection — not used on production code paths. */
    snapshot(): { tokens: number; queued: number; rate: number; burst: number };
    /** Test-only: wipe the bucket back to defaults (clears any pending drain timer). */
    reset(): void;
}

interface BucketState {
    tokens: number;
    lastRefillAt: number;
    queue: Array<() => void>;
    drainTimer: ReturnType<typeof setTimeout> | null;
}

/** Parse an int env var with a fallback, clamped to [min, max]. */
export function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
    if (!raw) return fallback;
    const n = parseInt(raw, 10);
    if (Number.isNaN(n)) return fallback;
    return Math.max(min, Math.min(max, n));
}

export function createProcessBucket(cfg: ProcessBucketConfig): ProcessBucket {
    const refillIntervalMs = 60_000 / cfg.ratePerMin;
    const g = globalThis as unknown as Record<string, BucketState | undefined>;

    function bucket(): BucketState {
        let b = g[cfg.globalKey];
        if (!b) {
            b = {
                tokens: cfg.maxTokens, // start full so the first burst doesn't queue
                lastRefillAt: Date.now(),
                queue: [],
                drainTimer: null,
            };
            g[cfg.globalKey] = b;
        }
        return b;
    }

    function refill(b: BucketState, now: number) {
        const elapsed = now - b.lastRefillAt;
        if (elapsed <= 0) return;
        b.tokens = Math.min(cfg.maxTokens, b.tokens + (elapsed / 60_000) * cfg.ratePerMin);
        b.lastRefillAt = now;
    }

    function drainQueue(b: BucketState) {
        while (b.queue.length > 0 && b.tokens >= 1) {
            b.tokens -= 1;
            const next = b.queue.shift()!;
            next();
        }
        if (b.queue.length > 0 && b.drainTimer === null) {
            // Schedule exactly ONE drain pass for when the next token is due.
            b.drainTimer = setTimeout(() => {
                const cur = bucket();
                cur.drainTimer = null;
                refill(cur, Date.now());
                drainQueue(cur);
            }, refillIntervalMs);
        }
    }

    return {
        async acquire() {
            const b = bucket();
            refill(b, Date.now());
            if (b.tokens >= 1 && b.queue.length === 0) {
                b.tokens -= 1;
                return;
            }
            if (b.queue.length >= cfg.burstCap) {
                throw new Error(
                    `${cfg.label} rate-limit queue at capacity (${cfg.burstCap}). Slow the caller or raise ${cfg.envHint}.`,
                );
            }
            await new Promise<void>((resolve) => {
                b.queue.push(resolve);
                // Kick a drain pass — the drain timer may not be scheduled yet.
                drainQueue(b);
            });
        },
        snapshot() {
            const b = bucket();
            refill(b, Date.now());
            return { tokens: b.tokens, queued: b.queue.length, rate: cfg.ratePerMin, burst: cfg.burstCap };
        },
        reset() {
            const b = g[cfg.globalKey];
            if (b?.drainTimer) clearTimeout(b.drainTimer);
            g[cfg.globalKey] = undefined;
        },
    };
}
