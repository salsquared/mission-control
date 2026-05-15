import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth-guards";
import { broadcastEvent } from "@/lib/events";
import { NotificationPatchSchema } from "@/lib/schemas/notifications";

export const runtime = "nodejs";

function userIdFromGuard(guard: { session: { user?: unknown } }): string | null {
    const user = guard.session.user as { id?: string } | undefined;
    return user?.id && user.id.length > 0 ? user.id : null;
}

function serialize(n: {
    id: string; userId: string; kind: string; title: string; body: string | null;
    payload: string; channels: string; createdAt: Date;
    readAt: Date | null; dismissedAt: Date | null;
}) {
    let payload: Record<string, unknown> = {};
    try { payload = JSON.parse(n.payload); } catch { /* malformed legacy row */ }
    return {
        id: n.id,
        userId: n.userId,
        kind: n.kind,
        title: n.title,
        body: n.body,
        payload,
        channels: n.channels,
        createdAt: n.createdAt.toISOString(),
        readAt: n.readAt?.toISOString() ?? null,
        dismissedAt: n.dismissedAt?.toISOString() ?? null,
    };
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export async function GET(req: NextRequest) {
    const guard = await requireSession();
    if ('error' in guard) return guard.error;
    const userId = userIdFromGuard(guard);
    if (!userId) return NextResponse.json({ error: "Session missing user.id" }, { status: 401 });

    const url = new URL(req.url);
    const unreadOnly = url.searchParams.get("unread") === "true";
    const limitRaw = Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(1, Math.floor(limitRaw)), MAX_LIMIT) : DEFAULT_LIMIT;

    const where: Record<string, unknown> = { userId };
    if (unreadOnly) where.readAt = null;

    try {
        const [rows, unreadCount] = await Promise.all([
            prisma.notification.findMany({
                where,
                orderBy: { createdAt: "desc" },
                take: limit,
            }),
            prisma.notification.count({ where: { userId, readAt: null } }),
        ]);
        return NextResponse.json({ notifications: rows.map(serialize), unreadCount }, { status: 200 });
    } catch (e) {
        console.error("[notifications GET] error:", e);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}

export async function PATCH(req: NextRequest) {
    const guard = await requireSession();
    if ('error' in guard) return guard.error;
    const userId = userIdFromGuard(guard);
    if (!userId) return NextResponse.json({ error: "Session missing user.id" }, { status: 401 });

    const parsed = NotificationPatchSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
        return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
    }

    try {
        let updated: number;
        if ("markAllRead" in parsed.data) {
            const r = await prisma.notification.updateMany({
                where: { userId, readAt: null },
                data: { readAt: new Date() },
            });
            updated = r.count;
        } else {
            const readAt = parsed.data.readAt ? new Date(parsed.data.readAt) : null;
            const r = await prisma.notification.updateMany({
                where: { id: { in: parsed.data.ids }, userId },
                data: { readAt },
            });
            updated = r.count;
        }
        if (updated > 0) {
            broadcastEvent({ model: 'Notification', action: 'upsert', id: userId, timestamp: Date.now() });
        }
        return NextResponse.json({ updated }, { status: 200 });
    } catch (e) {
        console.error("[notifications PATCH] error:", e);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
