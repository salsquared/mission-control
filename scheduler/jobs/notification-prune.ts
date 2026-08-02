/**
 * Audit item #2 (2026-05-24 audit, docs/next_steps.md §Audit-found soft bugs):
 * bound the growth of the `Notification` table.
 *
 * `WebhookDelivery` has had 30-day retention since PA-2; `Notification` had
 * none and grew monotonically (3,625 rows on dev.db / 4,967 on prod.db at
 * ~50-70 rows/day when this landed). Mirrors webhook-delivery-prune.ts.
 *
 * Retention: 90 days. Every reader's window is orders of magnitude smaller:
 *   - the bell (`GET /api/notifications`) takes the newest `limit` rows
 *     (DEFAULT_LIMIT=50, MAX_LIMIT=200) — barely 1-3 days of volume;
 *   - `?includeDismissed=true` is parsed by the route but has NO caller, so
 *     there is no "notification history" surface that reaches back;
 *   - the outbound-email circuit breaker (lib/notifications/circuit-breaker.ts)
 *     looks back 60s globally and at most 10 min per feature.
 * So nothing READS a 90-day-old row. What makes the predicate non-obvious is
 * what a row still WRITES, below.
 *
 * ---------------------------------------------------------------------------
 * Why deleting a row is not automatically safe: dedupKey suppression IS the row
 * ---------------------------------------------------------------------------
 * `Notification.dedupKey` is `@unique`, and dispatchNotification suppresses a
 * repeat by RACING that constraint (P2002 → return null). There is no separate
 * cooldown table: the surviving row's mere existence is the at-most-once guard.
 * Deleting a row therefore deletes its suppression, and the next dispatch with
 * that key fires a duplicate. So each key shape in use had to be checked for
 * whether it can RECUR after its row is gone:
 *
 *   - `stale-nudge:{appId}:{YYYY-MM-DD}`      (scheduler/jobs/stale-applications.ts)
 *   - `deadline:{appId}:{YYYY-MM-DD}`         (scheduler/jobs/deadline-nudges.ts)
 *   - `watchlist-closures:{wlId}:{YYYY-MM-DD}`(scheduler/jobs/job-watcher.ts)
 *       Safe. UTC date-bucketed via utcDateBucket(); calendar days advance
 *       monotonically, so a key from >90 days ago is never composed again.
 *
 *   - `posting-digest:{wlId}:{maxIncluded ISO}` (scheduler/jobs/posting-digest.ts)
 *       Safe. Keyed on the batch watermark, which only advances — and the job
 *       already refuses to reconsider postings behind its stored watermark.
 *
 *   - `event:{eventId}`                        (lib/repositories/applicationEvents.ts)
 *       Safe. `eventId` is a cuid that is never reused, and the per-event
 *       `ApplicationEvent.notifiedAt` checkpoint is an independent second
 *       guard — ingest only re-notifies events whose checkpoint is still null.
 *       Both would have to fail together, which needs a crash in the
 *       millisecond window between dispatch and checkpoint stamping; that
 *       retry drains through the FailedIngest queue in minutes, not 90 days.
 *
 *   - `posting:{externalId}`                   (scheduler/jobs/job-watcher.ts)
 *       THE ONE RESIDUAL RISK, deliberately accepted. This key is permanent by
 *       design (it collapses the same req surfacing on two watchlists into one
 *       notification — the Securitas / Rocket Lab / Raytheon dups found in
 *       prod). It is NOT date-bucketed, so a deleted row can be re-fired.
 *       Bounding the exposure: the notify branch is only reached when a
 *       JobPosting row is newly CREATED — the already-exists branch does
 *       `seenAgain++; continue;` without notifying. `JobPosting` is
 *       `@@unique([watchlistId, externalId])` and nothing outside tests ever
 *       deletes a JobPosting, so the SAME watchlist can never re-create one;
 *       that path is blocked independently of this table. The only reachable
 *       route is a DIFFERENT watchlist surfacing the same externalId for the
 *       first time >90 days after the original notification — i.e. the user
 *       adds a watchlist overlapping an existing one on a req that has stayed
 *       open for a quarter. Cost when it happens: exactly one duplicate
 *       low-tier, in-app-only bell row (posting notifications never email).
 *       We accept it because `posting:` keys are 57% of the table (2,054 of
 *       3,625 on dev.db) — exempting them would leave the dominant growth path
 *       unbounded and defeat the job entirely.
 *
 * ---------------------------------------------------------------------------
 * The one carve-out: never delete an unread, undismissed critical
 * ---------------------------------------------------------------------------
 * `GET /api/notifications` pins unread criticals (`pinnedWhere`: tier
 * "critical" + readAt null + dismissedAt null) OUTSIDE the recency window
 * precisely so an old offer/rejection/interview can't be buried by low-tier
 * volume. That pin is the single reader in the codebase with NO date bound, so
 * an unqualified `createdAt < cutoff` delete would be the only thing capable of
 * removing a row the UI is actively surfacing. The predicate below is exactly
 * the negation of that pin, so a pinned row is never swept. It costs nothing:
 * criticals run ~0.5 rows/day (37 `event:` rows in 76 days). Reading or
 * dismissing one makes it prunable on the next tick, which is the intent —
 * `dismissedAt` is the user saying they're done with it.
 *
 * Exported for the scheduler. The smoke at
 * scripts/tests/hermetic/notification-prune-smoke.ts exercises this against
 * dev.db with synthetic rows at the boundary.
 */
import { prisma } from "@/lib/prisma";

const RETENTION_DAYS = 90;

export interface NotificationPruneResult {
    deleted: number;
    cutoff: Date;
}

export async function runNotificationPrune(): Promise<NotificationPruneResult> {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const res = await prisma.notification.deleteMany({
        where: {
            createdAt: { lt: cutoff },
            // NOT(a AND b AND c) — preserve pinned (unread, undismissed)
            // criticals at any age. See the carve-out note above.
            NOT: { tier: "critical", readAt: null, dismissedAt: null },
        },
    });
    return { deleted: res.count, cutoff };
}
