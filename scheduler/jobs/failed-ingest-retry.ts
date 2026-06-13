/**
 * OQ9b (codebase review 2026-06-10 §7, P4.3.3) — drain the FailedIngest retry
 * queue: Gmail messages whose webhook ingest errored (classifier failure,
 * gmail.get failure, unexpected per-msg throw) get re-run through the SAME
 * idempotent ingest path with ×4 exponential backoff (5m → 20m → ~1.3h →
 * ~5.3h → ~21h → ~3.6d, attempt cap 6 — cumulative ≈ 4.7 days, inside Gmail's
 * ~7-day history window). Each queue attempt pays exactly ONE Gemini parse
 * call: ingest runs with the email parser's inner transient-retry disabled
 * (`parserRetry: false` → parseApplicationEmail `retry: false`, P4.2) — the
 * backoff IS the retry. Worst case per failed message: ≤7 parse calls EVER
 * (1 webhook + 6 queue).
 *
 * Per due row (nextRetryAt <= now AND attempts < MAX_ATTEMPTS):
 *   - success (created/updated/skipped — incl. `skipped: duplicate`) → row
 *     deleted, console.info.
 *   - gmail.get 404 (email deleted from the mailbox) → row deleted,
 *     console.info — retrying can never succeed.
 *   - failure → attempts += 1, lastError refreshed, nextRetryAt = now +
 *     retryDelayMs(attempts), and a per-attempt structured-warn ALARM naming
 *     attempt N/6 + the next retry time. The 6th failure is final: give-up
 *     warn naming Scan Inbox as the manual recovery; the row stays as visible
 *     inventory but is never selected again (attempts cap in the query).
 *   - prune: rows with firstFailedAt older than 30 days are deleted at the
 *     top of the tick (same policy as WebhookDelivery; folded in here — no
 *     separate job).
 *
 * ALARM DELIVERY IS DELIBERATELY DEFERRED (notification-system hold, per Sal
 * 2026-06-12): the "alarm" today is the structured row state + the structured
 * console.warn lines (ring buffer → data/logs.db → in-app log viewer). Do NOT
 * wire dispatchNotification / Notification rows / any frontend surface here
 * until the notification-system refactor lands.
 *
 * Registered in scheduler/index.ts's JOBS (5-min interval, matching the
 * 5-min first-retry delay) so it inherits wrapJob()'s overlap guard + one-shot
 * P2021 disable (a schema-behind tier degrades loudly, once).
 *
 * `deps.ingestOne` is a test seam: the hermetic smoke
 * (scripts/tests/hermetic/failed-ingest-retry-smoke.ts) injects a stub so the
 * queue flow runs against a throwaway DB with no Google auth / network. The
 * default builds one gmail client per user per tick (rows carry userId —
 * multi-user safe) and calls the real ingestGmailMessage.
 */
import { google, type gmail_v1 } from "googleapis";
import { prisma } from "@/lib/prisma";
import { getGoogleAuthClient } from "@/lib/googleapis";
import { ingestGmailMessage, type IngestOutcome } from "@/lib/applications/ingest";
import {
    MAX_ATTEMPTS,
    RETENTION_DAYS,
    retryDelayMs,
    truncateError,
    formatRetryAlarm,
    formatGiveUpAlarm,
} from "@/lib/applications/failed-ingest";

export interface FailedIngestRetryResult {
    /** Rows selected as due this tick. */
    due: number;
    /** Rows whose re-ingest succeeded (row deleted). */
    succeeded: number;
    /** Rows dropped because the email no longer exists (gmail.get 404). */
    dropped404: number;
    /** Rows that failed again and were rescheduled with backoff. */
    rescheduled: number;
    /** Rows that hit the attempt cap this tick (kept as inventory, never re-selected). */
    gaveUp: number;
    /** Rows pruned by the 30-day retention sweep. */
    pruned: number;
}

export interface FailedIngestRetryDeps {
    /** Test seam — defaults to the real per-user gmail client + ingestGmailMessage. */
    ingestOne?: (row: { msgId: string; userId: string }) => Promise<IngestOutcome>;
    /** Test seam — defaults to `() => new Date()`. */
    now?: () => Date;
}

export async function runFailedIngestRetry(
    deps: FailedIngestRetryDeps = {},
): Promise<FailedIngestRetryResult> {
    const now = deps.now ?? (() => new Date());
    const ingestOne = deps.ingestOne ?? buildDefaultIngestOne();

    // Retention sweep first — same 30d policy as WebhookDelivery. Capped rows
    // are never re-selected below, so age is the only thing that removes them.
    const pruneCutoff = new Date(now().getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const pruneRes = await prisma.failedIngest.deleteMany({
        where: { firstFailedAt: { lt: pruneCutoff } },
    });

    const dueRows = await prisma.failedIngest.findMany({
        where: { nextRetryAt: { lte: now() }, attempts: { lt: MAX_ATTEMPTS } },
        orderBy: { nextRetryAt: "asc" },
    });

    const result: FailedIngestRetryResult = {
        due: dueRows.length,
        succeeded: 0,
        dropped404: 0,
        rescheduled: 0,
        gaveUp: 0,
        pruned: pruneRes.count,
    };

    for (const row of dueRows) {
        let outcome: IngestOutcome;
        try {
            outcome = await ingestOne({ msgId: row.msgId, userId: row.userId });
        } catch (e: any) {
            // Unexpected throw (incl. auth-client construction failure) counts
            // as a failed attempt — the queue must always terminate, and no
            // parse call was multiplied (ingest either threw before the
            // classifier or the classifier itself failed once).
            outcome = { action: "errored", reason: `retry threw: ${e?.message ?? String(e)}` };
        }

        if (outcome.action !== "errored") {
            // Success — includes every skipped reason (duplicate,
            // already_present, irrelevant, …): ingest completed, the message
            // needs no further attempts. deleteMany: race-safe against the
            // webhook's clearFailedIngest removing the row mid-tick.
            await prisma.failedIngest.deleteMany({ where: { msgId: row.msgId } });
            result.succeeded++;
            console.info(
                `[failed-ingest-retry] msg ${row.msgId} recovered on attempt ` +
                `${row.attempts + 1}/${MAX_ATTEMPTS} (${outcome.action}` +
                `${"reason" in outcome ? `: ${outcome.reason}` : ""})`,
            );
            continue;
        }

        if (outcome.gmailStatus === 404) {
            // Email deleted from the mailbox — retrying can never succeed.
            await prisma.failedIngest.deleteMany({ where: { msgId: row.msgId } });
            result.dropped404++;
            console.info(
                `[failed-ingest-retry] msg ${row.msgId} no longer exists (gmail.get 404) — dropped`,
            );
            continue;
        }

        const attempts = row.attempts + 1;
        const lastError = truncateError(outcome.reason);
        if (attempts >= MAX_ATTEMPTS) {
            // Final failure — keep the row as visible inventory (the
            // attempts-cap in the selection query retires it; the 30d prune
            // removes it). Manual recovery: Scan Inbox.
            await prisma.failedIngest.update({
                where: { msgId: row.msgId },
                data: { attempts, lastError },
            });
            result.gaveUp++;
            console.warn(formatGiveUpAlarm({ msgId: row.msgId, lastError }));
            continue;
        }

        const nextRetryAt = new Date(now().getTime() + retryDelayMs(attempts));
        await prisma.failedIngest.update({
            where: { msgId: row.msgId },
            data: { attempts, lastError, nextRetryAt },
        });
        result.rescheduled++;
        console.warn(formatRetryAlarm({ msgId: row.msgId, attempts, nextRetryAt, lastError }));
    }

    return result;
}

/**
 * Default ingest path: one OAuth client + gmail handle per distinct user per
 * tick (rows carry userId — ingest only ever runs for that row's user), then
 * the same idempotent ingestGmailMessage the webhook uses, with the parser's
 * inner retry disabled so this attempt pays exactly one Gemini call.
 */
function buildDefaultIngestOne(): (row: { msgId: string; userId: string }) => Promise<IngestOutcome> {
    const gmailByUser = new Map<string, gmail_v1.Gmail>();
    return async ({ msgId, userId }) => {
        let gmail = gmailByUser.get(userId);
        if (!gmail) {
            const authClient = await getGoogleAuthClient(userId);
            gmail = google.gmail({ version: "v1", auth: authClient });
            gmailByUser.set(userId, gmail);
        }
        return ingestGmailMessage({ userId, gmail, msgId, parserRetry: false });
    };
}
