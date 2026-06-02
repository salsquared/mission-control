/**
 * Self-notification mail-loop guard (2026-06-01).
 *
 * mission-control sends its application notifications (OFFER / REJECTION /
 * INTERVIEW_SCHEDULED / ASSESSMENT_REQUESTED) FROM → TO the user's own Gmail
 * (see lib/email/send.ts:notificationToEmail — from and to are both
 * `user.email`). Those emails land back in the same INBOX the Gmail webhook
 * watches, so without a guard the webhook re-ingests mission-control's own
 * outbound mail, the LLM classifies it as a fresh application event, fires
 * another notification, sends another email — an amplifying feedback loop.
 *
 * Observed 2026-06-02: a single CalSAWS interview notification looped 552×
 * in ~20 minutes (each iteration a distinct Gmail msgId, so the per-message
 * @@unique(applicationId,emailMsgId,kind) dedup couldn't stop it; critical
 * tier bypasses quiet hours), only halted by Gmail's own send rate limit.
 *
 * Two signals identify our own outbound notifications, checked on ingest:
 *   1. The `X-Mission-Control: notification` header we stamp on every
 *      notification send (primary — survives the self-send round-trip and is
 *      immune to a user genuinely titling a real email "[mission-control] …").
 *   2. The `[mission-control] ` subject prefix every notification carries
 *      (fallback — catches notification emails that pre-date the header, i.e.
 *      anything already sitting in the inbox when this guard shipped).
 *
 * Pure / dependency-free so both the sender (lib/email/send.ts) and the
 * ingest path (lib/applications/ingest.ts) import the same source of truth.
 */

/** Custom header stamped on every outbound notification email. */
export const MC_NOTIFICATION_HEADER = "X-Mission-Control";
/** Value of {@link MC_NOTIFICATION_HEADER} on a notification email. */
export const MC_NOTIFICATION_HEADER_VALUE = "notification";
/** Subject prefix every notification email carries. Keep in sync with notificationToEmail. */
export const MC_SUBJECT_PREFIX = "[mission-control] ";

/**
 * True when an inbound Gmail message is one of mission-control's own outbound
 * notification emails (and so MUST NOT be ingested — see module docstring).
 *
 * @param mcHeader value of the `X-Mission-Control` header on the message, or
 *   null/undefined if absent (read via the case-insensitive headerValue helper).
 * @param subject the message Subject header.
 */
export function isSelfNotificationEmail(args: {
    subject?: string | null;
    mcHeader?: string | null;
}): boolean {
    if ((args.mcHeader ?? "").trim().toLowerCase() === MC_NOTIFICATION_HEADER_VALUE) return true;
    if ((args.subject ?? "").startsWith(MC_SUBJECT_PREFIX)) return true;
    return false;
}
