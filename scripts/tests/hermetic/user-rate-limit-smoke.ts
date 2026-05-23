// RAH-12 hermetic smoke for checkUserRateLimit — pure function over an
// explicit `now` so we drive the clock from the test, no Date.now().
// Run with: npx tsx scripts/tests/hermetic/user-rate-limit-smoke.ts

import { checkUserRateLimit, _resetUserRateLimitsForTest } from '@/lib/api/user-rate-limit';

interface Step { name: string; ok: boolean; detail?: string }
const steps: Step[] = [];
function record(name: string, ok: boolean, detail?: string) {
    steps.push({ name, ok, detail });
    console.info(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
}

// Fresh state per case so order-of-execution doesn't matter.
function fresh() { _resetUserRateLimitsForTest(); }

const userA = 'user-a';
const userB = 'user-b';
const limits = { max: 3, windowMs: 60_000 };  // 3 calls per minute
const t0 = 1_700_000_000_000;

// ─── First call admits and reports remaining ─────────────────────────────
{
    fresh();
    const d = checkUserRateLimit('scope', userA, t0, limits);
    record('first call: ok=true', d.ok);
    record('first call: remaining = max-1', d.remaining === 2);
    record('first call: retryAfter = 0', d.retryAfterSec === 0);
}

// ─── Hits the cap, blocks the 4th call ───────────────────────────────────
{
    fresh();
    checkUserRateLimit('scope', userA, t0, limits);
    checkUserRateLimit('scope', userA, t0 + 1_000, limits);
    checkUserRateLimit('scope', userA, t0 + 2_000, limits);
    const blocked = checkUserRateLimit('scope', userA, t0 + 3_000, limits);
    record('4th call within window: blocked', !blocked.ok);
    record('blocked: retryAfter > 0', blocked.retryAfterSec > 0);
    record('blocked: retryAfter ≤ window (sec)', blocked.retryAfterSec <= 60);
    record('blocked: remaining = 0', blocked.remaining === 0);
}

// ─── Oldest entry rolling off the window re-admits the next call ─────────
{
    fresh();
    checkUserRateLimit('scope', userA, t0,           limits);
    checkUserRateLimit('scope', userA, t0 + 10_000,  limits);
    checkUserRateLimit('scope', userA, t0 + 20_000,  limits);
    // At t0 + 65s, the t0 entry has rolled off (>60s old), so we should be back to 2 in window.
    const ok = checkUserRateLimit('scope', userA, t0 + 65_000, limits);
    record('after window roll-off: re-admitted', ok.ok);
}

// ─── Different userIds keep separate budgets ─────────────────────────────
{
    fresh();
    checkUserRateLimit('scope', userA, t0, limits);
    checkUserRateLimit('scope', userA, t0, limits);
    checkUserRateLimit('scope', userA, t0, limits);
    const a4 = checkUserRateLimit('scope', userA, t0, limits);
    const b1 = checkUserRateLimit('scope', userB, t0, limits);
    record('userA hits cap', !a4.ok);
    record('userB is unaffected', b1.ok && b1.remaining === 2);
}

// ─── Different scopes keep separate budgets ──────────────────────────────
{
    fresh();
    checkUserRateLimit('scope-x', userA, t0, limits);
    checkUserRateLimit('scope-x', userA, t0, limits);
    checkUserRateLimit('scope-x', userA, t0, limits);
    const xBlocked = checkUserRateLimit('scope-x', userA, t0, limits);
    const yFresh   = checkUserRateLimit('scope-y', userA, t0, limits);
    record('scope-x hits cap', !xBlocked.ok);
    record('scope-y is unaffected', yFresh.ok && yFresh.remaining === 2);
}

// ─── retryAfter calculation precision ────────────────────────────────────
{
    fresh();
    checkUserRateLimit('scope', userA, t0,         limits);  // oldest entry
    checkUserRateLimit('scope', userA, t0 + 100,   limits);
    checkUserRateLimit('scope', userA, t0 + 200,   limits);
    // Hit cap at t0 + 300. The oldest (t0) rolls off at t0 + 60000, so
    // retryAfter ≈ 60s - 0.3s ≈ 59.7s, rounded up to 60s.
    const d = checkUserRateLimit('scope', userA, t0 + 300, limits);
    record('retryAfter: rounds up from sub-second', !d.ok && d.retryAfterSec === 60);
}

// ─── Limiter does NOT record a call when rejecting ───────────────────────
{
    fresh();
    checkUserRateLimit('scope', userA, t0,        limits);
    checkUserRateLimit('scope', userA, t0,        limits);
    checkUserRateLimit('scope', userA, t0,        limits);
    // Rejected — should NOT advance the bucket.
    checkUserRateLimit('scope', userA, t0 + 5_000, limits);
    checkUserRateLimit('scope', userA, t0 + 5_001, limits);  // also rejected
    // At t0 + 61s the original three at t0 have all expired. Despite the
    // intervening rejections at t0+5_000, the bucket should now be EMPTY,
    // not "filled by the rejected attempts". Burn through 3 admissions.
    const r1 = checkUserRateLimit('scope', userA, t0 + 61_000, limits);
    const r2 = checkUserRateLimit('scope', userA, t0 + 61_000, limits);
    const r3 = checkUserRateLimit('scope', userA, t0 + 61_000, limits);
    record('rejected calls do not count: 3 admissions after roll-off',
        r1.ok && r2.ok && r3.ok);
}

const passed = steps.filter(s => s.ok).length;
const failed = steps.length - passed;
console.info(`\n${passed}/${steps.length} steps passed`);
if (failed > 0) {
    console.error(`${failed} step(s) failed`);
    process.exit(1);
}
console.info('All checks passed.');
