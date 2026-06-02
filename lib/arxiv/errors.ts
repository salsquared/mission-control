/**
 * Typed arXiv failure signals (docs/arxiv-rate-limit-fix.html — recovery layer).
 *
 * These let the research routes distinguish "arXiv is unavailable, degrade
 * gracefully" from a genuine bug. A route catching `ArxivUnavailableError`
 * re-throws it so `withSharedCache` serves last-good (stale) or a benign empty
 * fallback (200, uncached) — instead of a 500 + error-log cascade.
 *
 * `ArxivRateLimitCooldownError` is the circuit-breaker case: a recent 429 tripped
 * the cross-tier cooldown, so `acquireArxivSlot()` fast-fails WITHOUT touching
 * arXiv (no new request to keep the IP-level block alive). It is a subclass of
 * `ArxivUnavailableError`, so the same graceful-degrade path covers it.
 *
 * Kept in their own dependency-free module so lib/arxiv/rate-limit.ts,
 * lib/arxiv/fetch.ts, and the routes can all import them without a cycle.
 */

export class ArxivUnavailableError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ArxivUnavailableError";
    }
}

export class ArxivRateLimitCooldownError extends ArxivUnavailableError {
    readonly retryAfterSeconds: number;
    constructor(retryAfterSeconds: number) {
        super(`arXiv rate-limit cooldown active (~${retryAfterSeconds}s remaining); skipping call to let the IP block clear`);
        this.name = "ArxivRateLimitCooldownError";
        this.retryAfterSeconds = retryAfterSeconds;
    }
}
