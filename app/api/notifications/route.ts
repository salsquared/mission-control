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
    id: string; userId: string; kind: string; tier: string; title: string; body: string | null;
    payload: string; channels: string; createdAt: Date;
    readAt: Date | null; dismissedAt: Date | null;
}) {
    let payload: Record<string, unknown> = {};
    try {
        // The object check is load-bearing, not belt-and-braces: `"null"`, `"42"`
        // and `"[1,2]"` all PARSE fine but fail the schema's `z.record(...)`, and
        // jsonFetch validates the whole page — so one such row would invalidate
        // every notification, not just itself. Same divergence class this file's
        // dropped-`tier` bug belonged to.
        const parsed: unknown = JSON.parse(n.payload);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            payload = parsed as Record<string, unknown>;
        }
    } catch { /* malformed legacy row */ }
    return {
        id: n.id,
        userId: n.userId,
        kind: n.kind,
        // Load-bearing, not cosmetic: NotificationBell pins critical-tier unread
        // to the top and styles them. Omitting it here (as this serializer did
        // from c5c8905 until 2026-07-29) silently made that whole sort a no-op.
        tier: n.tier,
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

// Critical-tier pin (2026-07-29). NotificationBell sorts by tier client-side,
// but that sort can only reorder whatever this route already truncated to — so
// with a large low-tier backlog an unread critical (offer / rejection /
// interview) never arrives and the pin is a silent no-op. Measured before this
// fix: 0 of 4 unread criticals were in the newest-20 window on BOTH tiers,
// buried under 700+ unread low-tier posting rows.
//
// Ordering alone can't fix it: Prisma has no CASE ordering, and `tier` is a
// String column whose alphabetical order ('critical' < 'low' < 'standard')
// puts low ABOVE standard. So fetch unread criticals explicitly and merge them
// ahead of the recency window — correct regardless of how big the backlog
// grows, where a re-sort of a truncated page is not. Response contract is
// unchanged, so the client's own tier sort still applies and now agrees.
const PINNED_CRITICAL_CAP = 10;

export async function GET(req: NextRequest) {
    const guard = await requireSession();
    if ('error' in guard) return guard.error;
    const userId = userIdFromGuard(guard);
    if (!userId) return NextResponse.json({ error: "Session missing user.id" }, { status: 401 });

    const url = new URL(req.url);
    const unreadOnly = url.searchParams.get("unread") === "true";
    const includeDismissed = url.searchParams.get("includeDismissed") === "true";
    const limitRaw = Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(1, Math.floor(limitRaw)), MAX_LIMIT) : DEFAULT_LIMIT;

    const where: Record<string, unknown> = { userId };
    if (unreadOnly) where.readAt = null;
    // Default: hide dismissed notifications from the bell. Pass ?includeDismissed=true
    // for a debug / history view later.
    if (!includeDismissed) where.dismissedAt = null;

    // KEEP EVERY `where` MUTATION ABOVE THIS LINE — enforced, not just asked for.
    // The spread below snapshots `where`, so a filter added after it would apply
    // to the recency query but be silently ignored by the pin query: a
    // cross-filter leak with no type error to catch it. Freezing turns that into
    // a loud throw on the first request instead.
    Object.freeze(where);

    // `dismissedAt: null` is forced even under ?includeDismissed=true: dismissing
    // is an explicit "hide this", so a dismissed critical must never be re-pinned.
    // These literals sit AFTER the spread so they win in every flag combination —
    // which is what makes `pinnedWhere` a strict subset of `where`, and therefore
    // makes it impossible for the pin to surface a row the caller filtered out.
    const pinnedWhere = { ...where, tier: "critical", readAt: null, dismissedAt: null };

    try {
        const [rows, pinnedRows, unreadCount] = await Promise.all([
            prisma.notification.findMany({
                where,
                orderBy: { createdAt: "desc" },
                take: limit,
            }),
            prisma.notification.findMany({
                where: pinnedWhere,
                orderBy: { createdAt: "desc" },
                take: PINNED_CRITICAL_CAP,
            }),
            prisma.notification.count({ where: { userId, readAt: null, dismissedAt: null } }),
        ]);

        // Never exceed the caller's `limit` — a small limit yields criticals
        // first, which is the point. Dedupe by id so a critical already inside
        // the recency window isn't returned twice.
        const pinned = pinnedRows.slice(0, Math.min(limit, PINNED_CRITICAL_CAP));
        const pinnedIds = new Set(pinned.map(n => n.id));
        const merged = [...pinned, ...rows.filter(r => !pinnedIds.has(r.id))].slice(0, limit);

        return NextResponse.json({ notifications: merged.map(serialize), unreadCount }, { status: 200 });
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
        } else if ("dismissedAt" in parsed.data) {
            const dismissedAt = parsed.data.dismissedAt ? new Date(parsed.data.dismissedAt) : null;
            const r = await prisma.notification.updateMany({
                where: { id: { in: parsed.data.ids }, userId },
                // Dismissing also marks read — a notification a user has
                // explicitly hidden has by definition been seen.
                data: { dismissedAt, readAt: dismissedAt ? new Date() : null },
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
            // `id` intentionally omitted: this is a bulk updateMany, so there is
            // no single row to name. (It previously carried `id: userId` — one
            // of three sites smuggling a user id through the row-id field, all
            // normalized together; see lib/events.ts.)
            broadcastEvent({ model: 'Notification', action: 'upsert', userId, timestamp: Date.now() });
        }
        return NextResponse.json({ updated }, { status: 200 });
    } catch (e) {
        console.error("[notifications PATCH] error:", e);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
