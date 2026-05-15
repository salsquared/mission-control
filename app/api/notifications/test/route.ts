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
        });

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
