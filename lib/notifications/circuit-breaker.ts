/**
 * Outbound-email circuit breaker (Fix A — docs/postmortem-self-notification-mail-loop.html §11).
 *
 * The 2026-06-02 self-notification loop sent 552 emails in ~20 minutes and was
 * stopped only by Gmail's *external* send-rate throttle — nothing in the app
 * capped its own outbound volume. This module is the app owning that limit.
 *
 * Two layers, both evaluated before dispatchNotification fires the email
 * side-channel; if EITHER is at/over cap the email is suppressed (the in-app
 * row still lands — see OQ4):
 *
 *   1. Global per-user backstop — ≤ GLOBAL_EMAIL_CAP emails / GLOBAL_WINDOW_MS
 *      across ALL of mission-control, regardless of feature. The catch-all that
 *      would have stopped the 552-loop at 10.
 *   2. Per-feature limiter — an extensible registry keyed by Notification.kind.
 *      Today only `application` is registered (≤ 1 email / 10 min per job card,
 *      scoped by applicationId). Future features (postings, system) register
 *      their own rule; until they do they're covered by the global layer alone.
 *
 * COUNTING: we count notifications whose `channels` still include "email"
 * within the window — i.e. rows that actually *engaged* the email channel — not
 * rows with a non-null emailSentAt. This is deliberate and differs from an
 * earlier draft of the design doc:
 *   - A breaker must trip on *attempts*, not successes. If sends are failing
 *     (Gmail down) or muted (EMAIL_ENABLED=0) the runaway still needs stopping,
 *     and emailSentAt would be null on every one of those rows.
 *   - A breaker-suppressed or quiet-hours-suppressed row has "email" stripped
 *     from its channels, so it does NOT count toward the cap — correct, it
 *     didn't send. This makes the count self-consistent: only rows that reach
 *     the send path are tallied.
 *
 * The per-feature count is an exact-prefix lookup on the
 * @@index([userId, scopeKey, createdAt]) added in the 20260608 migration.
 */
import { prisma } from "@/lib/prisma";

/** Global per-user cap: ≤ 10 emails in the trailing 60 s, across all features. */
export const GLOBAL_EMAIL_CAP = 10;
export const GLOBAL_WINDOW_MS = 60_000;

/** The minimal slice of a dispatch the breaker needs (avoids importing DispatchInput → circular). */
export interface BreakerInput {
    userId: string;
    kind: string;
    payload?: Record<string, unknown>;
}

interface FeatureRule {
    /** Max emails allowed in `windowMs` for a single scope value. */
    cap: number;
    windowMs: number;
    /**
     * Compute the scopeKey for this dispatch, or null when the dispatch carries
     * no scope id (then the per-feature layer is skipped and only the global
     * backstop applies). Format: "<feature>:<id>".
     */
    scopeKey(input: BreakerInput): string | null;
}

/**
 * Per-feature registry. Keyed by Notification.kind. Add an entry here to put a
 * new feature under its own scoped limit — no other code changes needed; the
 * global backstop already covers every feature.
 */
export const FEATURE_REGISTRY: Record<string, FeatureRule> = {
    application: {
        cap: 1,
        windowMs: 10 * 60_000, // 10 minutes per job card
        scopeKey: (input) => {
            const id = input.payload?.applicationId;
            return typeof id === "string" && id.length > 0 ? `application:${id}` : null;
        },
    },
};

/**
 * The scopeKey to persist on this notification row (or null). Written by
 * dispatchNotification so the per-feature count can find it later.
 */
export function resolveScopeKey(input: BreakerInput): string | null {
    return FEATURE_REGISTRY[input.kind]?.scopeKey(input) ?? null;
}

export interface BreakerVerdict {
    tripped: boolean;
    /** e.g. "global 10/10 in 60s" or "application 1/1 in 600s". Set when tripped. */
    reason?: string;
}

function reasonFor(layer: string, count: number, cap: number, windowMs: number): string {
    return `${layer} ${count}/${cap} in ${Math.round(windowMs / 1000)}s`;
}

/**
 * Evaluate both breaker layers for a dispatch that is about to email. Returns
 * the first layer that is at/over cap. Best-effort by contract of the caller:
 * dispatchNotification wraps this so a breaker query failure never blocks the
 * notification (it just emails as normal — failing open is correct for a
 * defense-in-depth limiter).
 */
export async function checkOutboundEmailBreaker(input: BreakerInput): Promise<BreakerVerdict> {
    const now = Date.now();

    // ── Layer 1: global per-user backstop ──────────────────────────────────
    const globalCount = await prisma.notification.count({
        where: {
            userId: input.userId,
            createdAt: { gte: new Date(now - GLOBAL_WINDOW_MS) },
            channels: { contains: "email" },
        },
    });
    if (globalCount >= GLOBAL_EMAIL_CAP) {
        return { tripped: true, reason: reasonFor("global", globalCount, GLOBAL_EMAIL_CAP, GLOBAL_WINDOW_MS) };
    }

    // ── Layer 2: per-feature limiter ───────────────────────────────────────
    const rule = FEATURE_REGISTRY[input.kind];
    if (rule) {
        const sk = rule.scopeKey(input);
        if (sk) {
            const featureCount = await prisma.notification.count({
                where: {
                    userId: input.userId,
                    scopeKey: sk,
                    createdAt: { gte: new Date(now - rule.windowMs) },
                    channels: { contains: "email" },
                },
            });
            if (featureCount >= rule.cap) {
                return { tripped: true, reason: reasonFor(input.kind, featureCount, rule.cap, rule.windowMs) };
            }
        }
    }

    return { tripped: false };
}
