import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth-guards";
import { broadcastEvent } from "@/lib/events";
import { dispatchNotification } from "@/lib/notifications/dispatch";

export const runtime = "nodejs";
export const maxDuration = 30;

function userIdFromGuard(guard: { session: { user?: unknown } }): string | null {
    const user = guard.session.user as { id?: string } | undefined;
    return user?.id && user.id.length > 0 ? user.id : null;
}

// RAH-17: minimal in-memory rate limit. EMAIL_ENABLED=1 in prod means each
// call fires a real Gmail send — a stuck tab refresh-loop or curl loop could
// blow through the daily Gmail send quota in seconds. 30s/user is plenty for
// "I clicked the button" verification flows. Persists on globalThis so HMR
// during dev doesn't reset the gate.
const RATE_LIMIT_MS = 30_000;
const testLastSent: Map<string, number> =
    (globalThis as { __mcNotifTestRateLimit?: Map<string, number> }).__mcNotifTestRateLimit
    ?? new Map<string, number>();
(globalThis as { __mcNotifTestRateLimit?: Map<string, number> }).__mcNotifTestRateLimit = testLastSent;

/**
 * POST /api/notifications/test — sends a self-addressed verification email
 * through the Gmail OAuth pipeline so you can confirm the email side-channel
 * works without waiting for a real interview/offer event to come in.
 *
 * Creates a real Notification row with kind='system', channels='in_app,email',
 * then awaits the email dispatch and returns the updated row so the caller
 * can see emailSentAt / emailError synchronously.
 */
export async function POST(_req: NextRequest) {
    const guard = await requireSession();
    if ('error' in guard) return guard.error;
    const userId = userIdFromGuard(guard);
    if (!userId) return NextResponse.json({ error: "Session missing user.id" }, { status: 401 });

    const last = testLastSent.get(userId);
    const now = Date.now();
    if (last && now - last < RATE_LIMIT_MS) {
        const retryAfterSec = Math.ceil((RATE_LIMIT_MS - (now - last)) / 1000);
        return NextResponse.json(
            { error: `Rate limited — try again in ${retryAfterSec}s` },
            { status: 429, headers: { "Retry-After": String(retryAfterSec) } },
        );
    }
    testLastSent.set(userId, now);

    try {
        // The test endpoint forces email by overriding channels — it doesn't
        // matter what tier we pick for the row, the email side-channel kicks
        // in because "email" is in `channels`. Using tier='standard' for the
        // row's UI prominence (between low-volume posting and critical app).
        const created = await dispatchNotification({
            userId,
            tier: "standard",
            kind: "system",
            title: "mission-control email test",
            body: "If you're reading this in your inbox, the Gmail OAuth send pipeline is wired correctly. Generated at " + new Date().toISOString() + ".",
            payload: { test: true, sentAt: new Date().toISOString() },
            channels: "in_app,email",
            // No dedupKey — the test endpoint deliberately fires fresh each
            // call (subject to the per-user rate limit above).
        });
        if (!created) {
            // Defensive: only reachable if a dedupKey collision occurred, but
            // we didn't pass one. Surface so the user gets a clean error.
            return NextResponse.json({ error: "Dispatch returned null unexpectedly" }, { status: 500 });
        }

        // Re-fetch to surface emailSentAt / emailError from the dispatch.
        const refreshed = await prisma.notification.findUnique({ where: { id: created.id } });
        broadcastEvent({ model: 'Notification', action: 'upsert', id: userId, timestamp: Date.now() });
        return NextResponse.json({
            notification: refreshed,
            sent: !!refreshed?.emailSentAt,
            error: refreshed?.emailError,
        }, { status: 200 });
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[notifications/test] error:", e);
        return NextResponse.json({ error: msg }, { status: 500 });
    }
}
