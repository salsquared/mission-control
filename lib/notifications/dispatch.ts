/**
 * Global notification dispatcher.
 *
 *   import { dispatchNotification } from "@/lib/notifications/dispatch";
 *
 * Single entry point every background process calls when it has an event
 * worth surfacing to the user. The dispatcher decides which channels fire
 * based on the tier — callers don't reason about email vs in-app individually.
 *
 * Tiers
 *   - "critical"  → in-app + email. The user must see this.
 *     Examples: OFFER, REJECTION, INTERVIEW_SCHEDULED, ASSESSMENT_REQUESTED.
 *   - "standard"  → in-app only (email opt-in is a future setting). Important
 *     but not interrupt-the-user level.
 *     Examples: first-crawl posting digests, closed-posting summaries.
 *   - "low"       → in-app only. Visible in the bell, no push.
 *     Examples: per-posting watchlist notifications.
 *
 * Best-effort email side-channel: dispatchNotification ALWAYS succeeds at
 * creating the in-app row. If the row's tier warrants an email and Gmail
 * is unreachable / unauthorized, the failure is recorded onto
 * `emailError` on the same row and the function returns normally — the
 * caller's flow isn't blocked by an email outage.
 */
import { prisma } from "@/lib/prisma";
import type { Notification } from "@prisma/client";
import type { NotificationKind, NotificationTier } from "@/lib/schemas/notifications";
import { isInQuietHours } from "@/lib/notifications/quiet-hours";

export interface DispatchInput {
    userId: string;
    tier: NotificationTier;
    kind: NotificationKind;
    title: string;
    body?: string | null;
    payload?: Record<string, unknown>;
    /** Override the default channel set for this tier. Leave undefined to use the default. */
    channels?: string;
    /**
     * PB-8: at-most-once delivery key. When non-null and the same key was
     * already used, the create races on Notification.dedupKey @unique → P2002
     * → this function returns null (no row created, no email sent). Pattern
     * the key as `${kind}:${targetId}:${type}:${YYYY-MM-DD-UTC}` for daily
     * cadence; finer-grained scopes work too.
     */
    dedupKey?: string | null;
}

/**
 * Stable UTC `YYYY-MM-DD` bucket used by the standard cooldown callers
 * (stale-applications, deadline-nudges, posting-digest). Exported so callers
 * compose dedupKeys consistently — using server-local time would shift the
 * bucket boundary on DST changes and re-fire nudges within a single day.
 */
export function utcDateBucket(d: Date = new Date()): string {
    return d.toISOString().slice(0, 10);
}

/** Default channel set per tier. Keep in sync with the tier docstring above. */
function defaultChannelsForTier(tier: NotificationTier): string {
    switch (tier) {
        case "critical": return "in_app,email";
        case "standard": return "in_app";
        case "low":      return "in_app";
    }
}

/**
 * Create a Notification + fire any side-channels the tier warrants.
 *
 * Returns the created row, or NULL when a passed `dedupKey` collided with a
 * prior dispatch (PB-8 — race-safe at-most-once). Callers that pass dedupKey
 * MUST handle the null case. Callers that omit dedupKey can rely on a
 * non-null return.
 */
export async function dispatchNotification(input: DispatchInput): Promise<Notification | null> {
    let channels = input.channels ?? defaultChannelsForTier(input.tier);

    // Story 28 — quiet hours. If the user has a quiet-hours window
    // configured AND we're inside it AND this dispatch was going to email,
    // strip "email" from channels so the row still surfaces in the bell
    // but no Gmail send fires. Critical tier (offers, etc.) bypasses quiet
    // hours — the user explicitly wants those even at 3am.
    if (input.tier !== "critical" && channels.includes("email")) {
        const settings = await prisma.globalSetting.findUnique({
            where: { id: "global" },
            select: { quietHoursStart: true, quietHoursEnd: true, quietHoursTimezone: true },
        });
        if (settings && isInQuietHours(new Date(), {
            start: settings.quietHoursStart,
            end: settings.quietHoursEnd,
            timezone: settings.quietHoursTimezone,
        })) {
            channels = channels.split(",").map(c => c.trim()).filter(c => c !== "email").join(",");
        }
    }

    let row: Notification;
    try {
        row = await prisma.notification.create({
            data: {
                userId: input.userId,
                kind: input.kind,
                tier: input.tier,
                title: input.title,
                body: input.body ?? null,
                payload: JSON.stringify(input.payload ?? {}),
                channels,
                dedupKey: input.dedupKey ?? null,
            },
        });
    } catch (e: any) {
        // PB-8: dedupKey collision. Silently no-op so concurrent callers
        // converge on a single delivery. The losing caller never sends the
        // email because the row was never created here.
        if (e?.code === "P2002" && input.dedupKey) {
            return null;
        }
        throw e;
    }

    if (channels.split(",").map(c => c.trim()).includes("email")) {
        // Lazy import to avoid pulling googleapis into bundles that don't
        // need it (the dispatcher itself is server-only but lazy-loading
        // the heavy email path keeps cold-start fast for non-email callers).
        const { dispatchNotificationEmail } = await import("@/lib/email/send");
        await dispatchNotificationEmail(row.id);
    }

    return row;
}
