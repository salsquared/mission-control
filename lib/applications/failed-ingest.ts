/**
 * OQ9b (codebase review 2026-06-10 §7, P4.3) — FailedIngest retry-queue
 * helpers shared by the Gmail webhook (producer) and the scheduler retry job
 * (consumer, scheduler/jobs/failed-ingest-retry.ts).
 *
 * Contract (the queue owns the schedule):
 *   - The webhook records a row on every errored ingest outcome with
 *     attempts=0 and nextRetryAt = now + retryDelayMs(0) (5 min). On
 *     conflict it only refreshes lastError — it never bumps attempts or
 *     reschedules (a Pub/Sub re-walk re-failing the same msg is not a new
 *     queue attempt).
 *   - The retry job selects WHERE nextRetryAt <= now AND attempts < MAX_ATTEMPTS,
 *     re-runs the same idempotent ingest with the email parser's inner retry
 *     DISABLED (parseApplicationEmail's `retry: false`, P4.2), and on failure
 *     bumps attempts and reschedules with ×4 exponential backoff:
 *     5m → 20m → ~1.3h → ~5.3h → ~21h → ~3.6d (cumulative ≈ 4.7 days,
 *     inside Gmail's ~7-day history window). Worst case per failed message:
 *     ≤7 Gemini parse calls EVER (1 webhook + 6 queue).
 *   - Every failed attempt sounds an alarm: structured state on the row
 *     (attempts / lastError / nextRetryAt) + a structured console.warn
 *     (formatRetryAlarm / formatGiveUpAlarm below). Delivery wiring into
 *     dispatchNotification / the in-app bell is DELIBERATELY DEFERRED pending
 *     the notification-system refactor (per Sal 2026-06-12 — alarm side only).
 *
 * The backoff math + alarm formatting are pure exports so the hermetic smoke
 * (scripts/tests/hermetic/failed-ingest-retry-smoke.ts) can pin them without
 * a DB.
 */
import { prisma } from "@/lib/prisma";

/** Delay before the FIRST queue attempt (set by the webhook at row create). */
export const FIRST_RETRY_DELAY_MS = 5 * 60 * 1000;

/** ×4 exponential — each failure quadruples the wait. */
export const BACKOFF_FACTOR = 4;

/**
 * Queue attempts per message. The 6th failure is final: the row stays as
 * visible inventory (never re-selected — `attempts < MAX_ATTEMPTS` in the
 * query) until the 30-day prune.
 */
export const MAX_ATTEMPTS = 6;

/** FailedIngest rows older than this are pruned (same policy as WebhookDelivery). */
export const RETENTION_DAYS = 30;

/**
 * Cap stored error strings — classifier failures can embed whole API
 * responses; the row is an inventory entry, not a log archive.
 */
const MAX_ERROR_LENGTH = 500;

/**
 * Delay until the next retry, given the number of FAILED attempts so far.
 *   failedAttempts=0 → 5m (webhook row create → first queue attempt)
 *   failedAttempts=1 → 20m, 2 → ~1.3h, 3 → ~5.3h, 4 → ~21h, 5 → ~3.6d
 */
export function retryDelayMs(failedAttempts: number): number {
    return FIRST_RETRY_DELAY_MS * BACKOFF_FACTOR ** failedAttempts;
}

/**
 * Per-attempt alarm line (structured console.warn payload). `attempts` is
 * the attempt number that just failed (1-based, post-increment).
 */
export function formatRetryAlarm(input: {
    msgId: string;
    attempts: number;
    nextRetryAt: Date;
    lastError: string;
}): string {
    return (
        `[failed-ingest-retry] email ingest failed for msg ${input.msgId} ` +
        `(attempt ${input.attempts}/${MAX_ATTEMPTS}) — ` +
        `retrying ~${input.nextRetryAt.toISOString()}; ` +
        `last error: ${truncateError(input.lastError)}`
    );
}

/** Final give-up alarm line — names Scan Inbox as the manual recovery. */
export function formatGiveUpAlarm(input: { msgId: string; lastError: string }): string {
    return (
        `[failed-ingest-retry] email ingest GAVE UP on msg ${input.msgId} ` +
        `after ${MAX_ATTEMPTS}/${MAX_ATTEMPTS} attempts — ` +
        `run Scan Inbox to recover manually; ` +
        `last error: ${truncateError(input.lastError)}`
    );
}

export function truncateError(error: string): string {
    return error.length > MAX_ERROR_LENGTH ? error.slice(0, MAX_ERROR_LENGTH) + "…" : error;
}

/**
 * Webhook producer: upsert a FailedIngest row for an errored ingest outcome.
 * Create → attempts 0, nextRetryAt now+5m. Conflict → refresh lastError ONLY
 * (no attempts bump, no reschedule — the queue owns the schedule).
 *
 * Best-effort: a failure here (e.g. P2021 on a schema-behind tier) must never
 * abort the webhook's per-message loop or block the watermark advance.
 */
export async function recordFailedIngest(input: {
    msgId: string;
    userId: string;
    error: string;
    now?: Date;
}): Promise<void> {
    const now = input.now ?? new Date();
    const lastError = truncateError(input.error);
    try {
        await prisma.failedIngest.upsert({
            where: { msgId: input.msgId },
            create: {
                msgId: input.msgId,
                userId: input.userId,
                firstFailedAt: now,
                attempts: 0,
                lastError,
                nextRetryAt: new Date(now.getTime() + retryDelayMs(0)),
            },
            update: { lastError },
        });
    } catch (e) {
        console.warn(`[failed-ingest] could not record failed ingest for msg ${input.msgId}:`, e);
    }
}

/**
 * Drop any queued retry row for a msgId — called when the SAME message later
 * ingests successfully via the webhook (a history re-walk), making the queued
 * retry moot. Best-effort, same rationale as recordFailedIngest.
 */
export async function clearFailedIngest(msgId: string): Promise<void> {
    try {
        await prisma.failedIngest.deleteMany({ where: { msgId } });
    } catch (e) {
        console.warn(`[failed-ingest] could not clear failed-ingest row for msg ${msgId}:`, e);
    }
}
