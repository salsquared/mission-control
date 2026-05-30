/**
 * Classifies a Gmail API error as a "stale history" 404 — i.e.
 * `gmail.users.history.list` was called with a `startHistoryId` older than
 * Gmail's retained history window. This happens when the webhook has been down
 * longer than that window (~7 days): `lastSyncedHistoryId` falls off the back of
 * Gmail's history and the API returns 404.
 *
 * googleapis surfaces the not-found at different layers depending on the failure
 * path — a GaxiosError exposes `.code`, `.status`, and/or `.response.status`, as
 * a number or (occasionally) a string — so we check all three.
 *
 * Used by app/api/gmail/webhook/route.ts (C4 recovery, docs/archive/gmail-realtime-push.html
 * §3): on a stale-history 404 the webhook re-seeds `lastSyncedHistoryId` from the
 * push envelope and acks 200 instead of 500-ing. The next push then resumes
 * cleanly from the re-seeded point; the manual Scan Inbox backfill recovers the
 * gap. Any non-404 error is rethrown (still a real 500).
 */
export function isStaleHistoryError(err: unknown): boolean {
    if (!err || typeof err !== "object") return false;
    const e = err as { code?: unknown; status?: unknown; response?: { status?: unknown } };
    return [e.code, e.status, e.response?.status].some((c) => c === 404 || c === "404");
}
