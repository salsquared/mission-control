"use client";
import React, { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, BellRing, X, ExternalLink, Loader2, CheckCheck } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { api, queryKeys } from "@/lib/api-client";
import { useServerEvents } from "@/hooks/useServerEvents";
import { toastStore } from "@/lib/toast-store";

function errMessage(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

function fmtRelative(iso: string): string {
    const ms = Date.now() - new Date(iso).getTime();
    if (ms < 60_000) return "just now";
    if (ms < 3600_000) return `${Math.floor(ms / 60_000)}m ago`;
    if (ms < 86400_000) return `${Math.floor(ms / 3600_000)}h ago`;
    return `${Math.floor(ms / 86400_000)}d ago`;
}

const KIND_DOT_COLOR: Record<string, string> = {
    application: "bg-amber-400",
    posting: "bg-cyan-400",
    system: "bg-slate-400",
};

/**
 * Global notification bell. Lives in Dashboard.tsx as a sibling overlay so
 * it's reachable from every dash. Driven by /api/notifications + SSE
 * 'Notification' channel.
 */
export const NotificationBell: React.FC = () => {
    const queryClient = useQueryClient();
    const [open, setOpen] = useState(false);
    const [busyIds, setBusyIds] = useState<Set<string>>(new Set());

    const { data, isLoading } = useQuery({
        queryKey: queryKeys.notifications(),
        queryFn: () => api.notifications.list({ limit: 20 }),
        // Poll lightly even without SSE — covers the scheduler-process gap
        // where Notifications written from outside the Next.js process won't
        // trigger SSE broadcasts.
        refetchInterval: 60_000,
    });

    useServerEvents("Notification", () => {
        queryClient.invalidateQueries({ queryKey: queryKeys.notifications() });
    });

    // Pin critical-tier unread notifications to the top regardless of recency
    // — a posting that landed 5 minutes ago shouldn't bury an offer that came
    // in this morning. Tier ordering: critical > standard > low. Within tier,
    // unread first, then createdAt desc.
    const notifications = useMemo(() => {
        const rows = data?.notifications ?? [];
        const tierRank: Record<string, number> = { critical: 0, standard: 1, low: 2 };
        return [...rows].sort((a, b) => {
            const aUnread = a.readAt ? 1 : 0;
            const bUnread = b.readAt ? 1 : 0;
            // critical-unread always wins
            const aCriticalUnread = a.tier === "critical" && !a.readAt ? 0 : 1;
            const bCriticalUnread = b.tier === "critical" && !b.readAt ? 0 : 1;
            if (aCriticalUnread !== bCriticalUnread) return aCriticalUnread - bCriticalUnread;
            // then by tier
            const tierDiff = (tierRank[a.tier] ?? 99) - (tierRank[b.tier] ?? 99);
            if (tierDiff !== 0) return tierDiff;
            // then unread before read
            if (aUnread !== bUnread) return aUnread - bUnread;
            // then by recency
            return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
        });
    }, [data]);
    const unread = data?.unreadCount ?? 0;
    const hasUnread = unread > 0;

    async function dismiss(id: string) {
        setBusyIds(prev => new Set(prev).add(id));
        try {
            await api.notifications.update({
                ids: [id],
                dismissedAt: new Date().toISOString(),
            } as never); // discriminated-union nuance in zod schema
            queryClient.invalidateQueries({ queryKey: queryKeys.notifications() });
        } catch (e) {
            toastStore.push({ message: `Dismiss failed: ${errMessage(e)}`, type: "error" });
        } finally {
            setBusyIds(prev => {
                const next = new Set(prev);
                next.delete(id);
                return next;
            });
        }
    }

    async function markRead(id: string) {
        setBusyIds(prev => new Set(prev).add(id));
        try {
            await api.notifications.update({
                ids: [id],
                readAt: new Date().toISOString(),
            } as never);
            queryClient.invalidateQueries({ queryKey: queryKeys.notifications() });
        } catch (e) {
            toastStore.push({ message: `Mark read failed: ${errMessage(e)}`, type: "error" });
        } finally {
            setBusyIds(prev => {
                const next = new Set(prev);
                next.delete(id);
                return next;
            });
        }
    }

    async function markAllRead() {
        try {
            await api.notifications.update({ markAllRead: true });
            queryClient.invalidateQueries({ queryKey: queryKeys.notifications() });
        } catch (e) {
            toastStore.push({ message: `Mark all read failed: ${errMessage(e)}`, type: "error" });
        }
    }

    return (
        <>
            <button
                onClick={() => setOpen(o => !o)}
                aria-label={hasUnread ? `Notifications — ${unread} unread` : "Notifications"}
                className="fixed top-4 right-4 z-40 flex items-center justify-center w-10 h-10 rounded-full bg-black/40 border border-white/10 hover:border-white/20 hover:bg-black/60 backdrop-blur-sm text-white/70 hover:text-white transition-all shadow-lg"
            >
                {hasUnread ? <BellRing className="w-4 h-4" /> : <Bell className="w-4 h-4" />}
                {hasUnread && (
                    <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-rose-500 text-white text-[10px] font-bold flex items-center justify-center border border-neutral-900">
                        {unread > 99 ? "99+" : unread}
                    </span>
                )}
            </button>

            <AnimatePresence>
                {open && (
                    <>
                        <motion.div
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            className="fixed inset-0 z-40"
                            onClick={() => setOpen(false)}
                        />
                        <motion.div
                            initial={{ opacity: 0, x: 20, scale: 0.95 }}
                            animate={{ opacity: 1, x: 0, scale: 1 }}
                            exit={{ opacity: 0, x: 20, scale: 0.95 }}
                            className="fixed top-16 right-4 w-[380px] max-h-[70vh] z-50 rounded-2xl border border-white/10 bg-neutral-950/95 backdrop-blur-md shadow-2xl flex flex-col overflow-hidden"
                        >
                            <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 shrink-0">
                                <div className="flex items-center gap-2">
                                    <Bell className="w-4 h-4 text-white/60" />
                                    <h3 className="text-sm font-semibold text-white">Notifications</h3>
                                    {hasUnread && (
                                        <span className="text-[10px] uppercase tracking-wider text-rose-300/80 bg-rose-500/10 border border-rose-500/20 px-1.5 py-0.5 rounded">
                                            {unread} unread
                                        </span>
                                    )}
                                </div>
                                <div className="flex items-center gap-2">
                                    {hasUnread && (
                                        <button
                                            onClick={markAllRead}
                                            className="flex items-center gap-1 text-[11px] text-white/50 hover:text-white/80 transition-colors"
                                            title="Mark all read"
                                        >
                                            <CheckCheck className="w-3 h-3" />
                                            All read
                                        </button>
                                    )}
                                    <button
                                        onClick={() => setOpen(false)}
                                        className="text-white/40 hover:text-white/80"
                                        aria-label="Close"
                                    >
                                        <X className="w-4 h-4" />
                                    </button>
                                </div>
                            </div>

                            <div className="flex-1 overflow-y-auto">
                                {isLoading ? (
                                    <div className="flex items-center justify-center py-10 text-white/40">
                                        <Loader2 className="w-4 h-4 animate-spin" />
                                    </div>
                                ) : notifications.length === 0 ? (
                                    <div className="px-4 py-10 text-center text-xs text-white/40 italic">
                                        No notifications. New postings, interviews scheduled, offers, and rejections will land here.
                                    </div>
                                ) : (
                                    <ul className="divide-y divide-white/5">
                                        {notifications.map(n => {
                                            const isUnread = !n.readAt;
                                            const busy = busyIds.has(n.id);
                                            const dotColor = KIND_DOT_COLOR[n.kind] ?? "bg-white/40";
                                            const payload = (n.payload ?? {}) as { sourceUrl?: string; applicationId?: string };
                                            const sourceUrl = typeof payload.sourceUrl === "string" ? payload.sourceUrl : null;
                                            const isCritical = n.tier === "critical";
                                            return (
                                                <li
                                                    key={n.id}
                                                    onClick={() => isUnread && !busy && markRead(n.id)}
                                                    className={[
                                                        "group relative px-3 py-2.5 transition-colors",
                                                        isUnread ? "bg-white/[0.03] hover:bg-white/[0.06] cursor-pointer" : "hover:bg-white/[0.03]",
                                                        // Red left rail for critical-unread; muted red for critical-already-read so the user still
                                                        // recognizes which thread mattered.
                                                        isCritical && isUnread ? "border-l-2 border-rose-500" : isCritical ? "border-l-2 border-rose-500/30" : "",
                                                    ].join(" ")}
                                                >
                                                    <div className="flex items-start gap-2">
                                                        <span className={`mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 ${isUnread ? dotColor : "bg-white/20"}`} />
                                                        <div className="flex-1 min-w-0 pr-6">
                                                            <div className="flex items-center gap-2">
                                                                <span className={`text-sm font-semibold truncate ${isUnread ? "text-white" : "text-white/60"}`}>
                                                                    {n.title}
                                                                </span>
                                                            </div>
                                                            {n.body && (
                                                                <p className={`text-[11px] mt-0.5 line-clamp-2 ${isUnread ? "text-white/70" : "text-white/40"}`}>
                                                                    {n.body}
                                                                </p>
                                                            )}
                                                            <div className="flex items-center gap-2 mt-1 text-[10px] text-white/40">
                                                                <span>{fmtRelative(n.createdAt)}</span>
                                                                <span className="uppercase tracking-wider">{n.kind}</span>
                                                                {sourceUrl && (
                                                                    <a
                                                                        href={sourceUrl}
                                                                        target="_blank"
                                                                        rel="noopener noreferrer"
                                                                        onClick={(e) => e.stopPropagation()}
                                                                        className="inline-flex items-center gap-0.5 text-cyan-300/70 hover:text-cyan-200"
                                                                    >
                                                                        source
                                                                        <ExternalLink className="w-2.5 h-2.5" />
                                                                    </a>
                                                                )}
                                                            </div>
                                                        </div>
                                                        <button
                                                            onClick={(e) => { e.stopPropagation(); dismiss(n.id); }}
                                                            disabled={busy}
                                                            className="absolute top-2 right-2 p-0.5 rounded text-white/30 hover:text-white/80 hover:bg-white/10 opacity-0 group-hover:opacity-100 transition-opacity disabled:opacity-40"
                                                            title="Dismiss"
                                                        >
                                                            {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <X className="w-3 h-3" />}
                                                        </button>
                                                    </div>
                                                </li>
                                            );
                                        })}
                                    </ul>
                                )}
                            </div>
                        </motion.div>
                    </>
                )}
            </AnimatePresence>
        </>
    );
};
