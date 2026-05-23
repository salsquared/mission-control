// RAH-12 — per-userId sliding-window rate limit for expensive routes.
//
// Backs Gemini-call routes (POST /api/resumes, POST /api/profile/import)
// where the existing process-wide acquireGeminiSlot covers vendor-side
// quota but doesn't stop a logged-in tab in a refresh loop from burning
// through the user's daily generation budget. This guard adds a per-user
// budget at the route layer so an accidental loop can't fan out.
//
// State is per-key + per-userId, kept on globalThis so HMR doesn't reset
// the limiter in dev. Window is a sliding log of recent timestamps
// (millisecond precision); cheap for the small N we cap to and avoids
// the bucket-refill arithmetic of a token bucket. Pure check function
// underneath — the route layer reads `now` from `Date.now()`, the smoke
// passes it in.

export interface RateLimitOptions {
    /** Maximum allowed calls within `windowMs`. */
    max: number;
    /** Sliding window length in milliseconds. */
    windowMs: number;
}

export interface RateLimitDecision {
    ok: boolean;
    /** Seconds the caller must wait before another call would succeed. Always present when !ok. */
    retryAfterSec: number;
    /** How many calls remain in the current window (only meaningful when ok). */
    remaining: number;
}

// Per-(scope-key, userId) sliding log of timestamps. Module-local so
// different scopes (e.g. "resumes:gen" vs "profile:import") don't
// share a budget.
type WindowLog = Map<string, number[]>;
const globalForRateLimit = globalThis as { __mcUserRateLimits?: Map<string, WindowLog> };
if (!globalForRateLimit.__mcUserRateLimits) {
    globalForRateLimit.__mcUserRateLimits = new Map();
}
const REGISTRY: Map<string, WindowLog> = globalForRateLimit.__mcUserRateLimits;

function logFor(scope: string): WindowLog {
    let log = REGISTRY.get(scope);
    if (!log) {
        log = new Map();
        REGISTRY.set(scope, log);
    }
    return log;
}

/**
 * Check the rate limit AND record the current call if allowed. When the
 * limit is hit, returns ok=false + retryAfterSec without recording — the
 * caller (route) returns 429 and the bucket doesn't advance.
 *
 * `now` is parameterised so unit tests can drive the clock; production
 * callers pass `Date.now()`.
 */
export function checkUserRateLimit(
    scope: string,
    userId: string,
    now: number,
    opts: RateLimitOptions,
): RateLimitDecision {
    const log = logFor(scope);
    const arr = log.get(userId) ?? [];
    const cutoff = now - opts.windowMs;
    // Drop expired entries in place.
    const recent = arr.filter(t => t > cutoff);

    if (recent.length >= opts.max) {
        // Compute retry-after from the oldest entry that would need to roll
        // off before we'd be back under the cap.
        const oldest = recent[0];
        const retryAfterMs = Math.max(0, oldest + opts.windowMs - now);
        return {
            ok: false,
            retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000)),
            remaining: 0,
        };
    }

    recent.push(now);
    log.set(userId, recent);
    return {
        ok: true,
        retryAfterSec: 0,
        remaining: Math.max(0, opts.max - recent.length),
    };
}

/** Test-only: clear all rate-limit state. Hermetic smokes use this between cases. */
export function _resetUserRateLimitsForTest(): void {
    REGISTRY.clear();
}
