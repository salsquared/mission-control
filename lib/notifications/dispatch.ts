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

export interface DispatchInput {
    userId: string;
    tier: NotificationTier;
    kind: NotificationKind;
    title: string;
    body?: string | null;
    payload?: Record<string, unknown>;
    /** Override the default channel set for this tier. Leave undefined to use the default. */
    channels?: string;
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
 * Always returns the row (even if the email dispatch had to swallow an error).
 */
export async function dispatchNotification(input: DispatchInput): Promise<Notification> {
    const channels = input.channels ?? defaultChannelsForTier(input.tier);
    const row = await prisma.notification.create({
        data: {
            userId: input.userId,
            kind: input.kind,
            tier: input.tier,
            title: input.title,
            body: input.body ?? null,
            payload: JSON.stringify(input.payload ?? {}),
            channels,
        },
    });

    if (channels.split(",").map(c => c.trim()).includes("email")) {
        // Lazy import to avoid pulling googleapis into bundles that don't
        // need it (the dispatcher itself is server-only but lazy-loading
        // the heavy email path keeps cold-start fast for non-email callers).
        const { dispatchNotificationEmail } = await import("@/lib/email/send");
        await dispatchNotificationEmail(row.id);
    }

    return row;
}
