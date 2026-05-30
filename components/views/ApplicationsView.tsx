import React, { useState, useCallback, useRef, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Section } from "../Section";
import { Loader2, Mail, RefreshCw, Calendar as CalendarIcon, Plus, Inbox, RotateCw, Pencil, Briefcase } from "lucide-react";
import { useSession, signIn } from "next-auth/react";
import { CalendarWidget } from "../widgets/CalendarWidget";
import { CardGrid, CardItem } from "../grids/CardGrid";
import { Card } from "../ui/Card";
import { Scrollbar } from "../ui/Scrollbar";
import { useServerEvents } from "@/hooks/useServerEvents";
import { api, queryKeys } from "@/lib/api-client";
import { toastStore } from "@/lib/toast-store";
import { AddApplicationModal } from "../overlays/AddApplicationModal";
import { ApplicationDetailOverlay } from "../overlays/ApplicationDetailOverlay";
import { WatchlistsCard } from "../cards/applications/WatchlistsCard";
import { NewPostingsCard } from "../cards/applications/NewPostingsCard";
import { ApplicationsKanbanCard, AppRecord } from "../cards/applications/ApplicationsKanbanCard";
import { useAppStore, type PostingsTrackKey } from "../providers/state";

// The track switch (the one new asset of the single-track redo, see
// docs/archive/applications-view-redo.html). Config-driven so renaming a track or
// adding a third is a one-line edit here — the switch + layout pick it up for
// free. `id` must stay in lockstep with APPLICATION_TRACKS (lib/schemas/
// applications.ts) and the per-card TRACK_PRESETS maps.
const TRACKS: ReadonlyArray<{
    id: PostingsTrackKey;
    label: string;
    icon: typeof Mail;
    activeClass: string;
}> = [
    { id: "career", label: "Career", icon: Mail, activeClass: "bg-blue-500/20 text-blue-200 border-blue-400/40" },
    { id: "side", label: "Side", icon: Briefcase, activeClass: "bg-amber-500/20 text-amber-200 border-amber-400/40" },
] as const;

// Track-colored glow rgb — cyan-400 (career) / amber-500 (side).
const TRACK_GLOW_RGB: Record<PostingsTrackKey, string> = {
    career: "34, 211, 238",
    side: "245, 158, 11",
};

// Seeded radial-gradient glow for the three switchable cards. The origin is
// pseudo-random but STABLE per card id (hash → fixed x/y, so it never shuffles
// on reload), and the color follows the active track. Rendered as a
// background-image so it layers over the card's bg-black/40 background-color.
function trackGlow(cardId: string, track: PostingsTrackKey): React.CSSProperties {
    let h = 0;
    for (let i = 0; i < cardId.length; i++) h = (h * 31 + cardId.charCodeAt(i)) >>> 0;
    const x = 12 + (h % 76);            // 12–88%
    const y = 12 + ((h >>> 8) % 76);    // 12–88%
    return {
        backgroundImage: `radial-gradient(circle at ${x}% ${y}%, rgba(${TRACK_GLOW_RGB[track]}, 0.20) 0%, transparent 62%)`,
    };
}

export const ApplicationsView: React.FC = () => {
    const { data: session, status } = useSession();
    const [isCalendarAdding, setIsCalendarAdding] = useState(false);
    const [isCalendarEditing, setIsCalendarEditing] = useState(false);
    const [isScanning, setIsScanning] = useState(false);
    const [isSyncing, setIsSyncing] = useState(false);
    const [isAdding, setIsAdding] = useState(false);
    const [detailAppId, setDetailAppId] = useState<string | null>(null);

    // Single-track switch selection (per-device, persisted). The kanban + the
    // two discovery cards all re-point to this track; Upcoming Interviews and
    // Account Status stay shared across tracks.
    const activeTrack = useAppStore(s => s.applicationsTrack);
    const setApplicationsTrack = useAppStore(s => s.setApplicationsTrack);

    // Track first-time authentication so background session revalidations
    // (window focus, periodic refetch, cross-device signin) don't unmount
    // the whole subtree when status briefly flips back through "loading".
    const hasEverAuthedRef = useRef(false);
    if (status === "authenticated") hasEverAuthedRef.current = true;

    const queryClient = useQueryClient();
    // Both tracks' apps stay queried even though only one renders at a time:
    // it keeps the dual-cache optimistic handleStatusChange and the kanban's
    // "move to other track" bulk action working without a rewrite, and the
    // switch flips instantly (no refetch flash). The discovery cards fetch
    // their own per-track data internally and now mount once, not twice.
    const { data: appsData, isLoading: loading } = useQuery({
        queryKey: queryKeys.applications,
        queryFn: () => api.applications.list({ track: 'career' }),
        enabled: Boolean(session),
    });
    const { data: sideAppsData, isLoading: sideLoading } = useQuery({
        queryKey: [...queryKeys.applications, 'side'] as const,
        queryFn: () => api.applications.list({ track: 'side' }),
        enabled: Boolean(session),
    });
    const apps: AppRecord[] = (appsData?.applications ?? []) as unknown as AppRecord[];
    const sideApps: AppRecord[] = (sideAppsData?.applications ?? []) as unknown as AppRecord[];
    const activeApps = activeTrack === 'side' ? sideApps : apps;
    const activeLoading = activeTrack === 'side' ? sideLoading : loading;

    // Predicate-based invalidation covers both `['applications']` and
    // `['applications', 'side']` so a single Application SSE event refreshes
    // both kanbans (a row could have its track flipped, which removes it from
    // one list and inserts into the other).
    const invalidateApps = useCallback(
        () => queryClient.invalidateQueries({
            predicate: (q) => Array.isArray(q.queryKey) && q.queryKey[0] === 'applications',
        }),
        [queryClient]
    );
    useServerEvents('Application', invalidateApps);
    useServerEvents('CalendarEvent', invalidateApps);

    const handleStatusChange = useCallback(async (id: string, newStatus: string) => {
        // The dragged row could be in either the career or the side cache.
        // Locate it and patch the matching cache optimistically so the kanban
        // reflects the new status before the server round-trip completes.
        const careerKey = queryKeys.applications;
        const sideKey = [...queryKeys.applications, 'side'] as const;
        const careerPrev = queryClient.getQueryData<{ applications: AppRecord[] }>(careerKey);
        const sidePrev = queryClient.getQueryData<{ applications: AppRecord[] }>(sideKey);
        const inCareer = (careerPrev?.applications ?? []).some(a => a.id === id);
        const targetKey = inCareer ? careerKey : sideKey;
        queryClient.setQueryData<{ applications: AppRecord[] }>(targetKey, (old) => ({
            applications: (old?.applications ?? []).map((a) =>
                a.id === id ? { ...a, status: newStatus, lastUpdateAt: new Date().toISOString() } : a
            ),
        }));
        try {
            await api.applications.update({ id, status: newStatus as any });
            queryClient.invalidateQueries({ queryKey: ['application-events'] });
        } catch (e: any) {
            // Roll back only the cache we touched.
            queryClient.setQueryData(targetKey, inCareer ? careerPrev : sidePrev);
            toastStore.push({ message: `Status update failed: ${e.message}`, type: 'error' });
        }
    }, [queryClient]);

    const syncFromGcal = useCallback(async (silent = false) => {
        if (!session) return;
        setIsSyncing(true);
        try {
            const result = await api.applications.events.sync();
            if (result.applied > 0 || result.deleted > 0) {
                queryClient.invalidateQueries({ queryKey: ['application-events'] });
                if (!silent) {
                    toastStore.push({
                        message: `Gcal sync: ${result.applied} updated · ${result.deleted} removed`,
                        type: 'info',
                    });
                }
            } else if (!silent) {
                toastStore.push({ message: result.reset ? 'Gcal sync reset — re-run to pull' : 'Gcal: no changes', type: 'info' });
            }
        } catch (e: any) {
            if (!silent) toastStore.push({ message: `Gcal sync failed: ${e.message}`, type: 'error' });
        } finally {
            setIsSyncing(false);
        }
    }, [session, queryClient]);

    // Background poll while the view is mounted. 5-min cadence so we don't
    // hammer Google; the syncToken makes each tick cheap. Silent toasts —
    // user only sees noise when they hit "Sync now" themselves.
    useEffect(() => {
        if (!session) return;
        const id = setInterval(() => syncFromGcal(true), 5 * 60 * 1000);
        return () => clearInterval(id);
    }, [session, syncFromGcal]);

    const scanInbox = useCallback(async () => {
        setIsScanning(true);
        try {
            const result = await api.applications.backfill();
            await invalidateApps();
            const parts = [
                `Scanned ${result.scanned}`,
                `${result.created} new`,
                `${result.updated} updated`,
                `${result.skipped} skipped`,
            ];
            // Surface errored count explicitly — otherwise a silent classifier
            // crash (e.g. missing GEMINI key) reads as "everything was skipped"
            // and the user never knows the pipeline is broken.
            if (result.errored > 0) parts.push(`${result.errored} errored`);
            const summary = parts.join(' · ');
            toastStore.push({
                message: result.truncated ? `${summary} (truncated — re-run for more)` : summary,
                type: result.errored > 0 ? 'warning' : 'info',
            });
        } catch (e: any) {
            toastStore.push({ message: `Scan failed: ${e.message}`, type: 'error' });
        } finally {
            setIsScanning(false);
        }
    }, [invalidateApps]);

    if (status === "loading" && !hasEverAuthedRef.current) {
        return (
            <div className="w-full h-full flex items-center justify-center">
                <Loader2 className="w-8 h-8 text-blue-500 animate-spin" />
            </div>
        );
    }

    // Single card stack for the active track. In a 2-column CardGrid,
    // colSpan:2 = full width and colSpan:1 = half; grid-flow-row-dense resolves
    // the order to: Interviews (full) → Kanban (full) → [New Postings · Watchlists]
    // → Account Status (full). The kanban + discovery cards carry key={activeTrack}
    // so flipping the switch remounts them (resets page / search / select state)
    // while the CardItem-keyed frame stays put.
    const pipelineCards: CardItem[] = [
        {
            id: "calendar",
            colSpan: 2,
            className: "max-h-[40vh]",
            content: (
                <Card
                    title="Upcoming Interviews"
                    icon={CalendarIcon}
                    iconColorClass="text-emerald-400"
                    action={
                        <div className="flex items-center gap-1.5">
                            <button
                                onClick={() => setIsCalendarEditing(!isCalendarEditing)}
                                className={`p-1.5 rounded-lg transition-colors cursor-pointer ${isCalendarEditing ? "bg-amber-500/20 text-amber-300" : "bg-amber-500/10 hover:bg-amber-500/20 text-amber-400"}`}
                                title={isCalendarEditing ? "Done editing" : "Edit events"}
                            >
                                <Pencil className="w-4 h-4" />
                            </button>
                            <button
                                onClick={() => setIsCalendarAdding(!isCalendarAdding)}
                                className="p-1.5 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 rounded-lg transition-colors cursor-pointer"
                                title="Add Event"
                            >
                                <Plus className="w-4 h-4" />
                            </button>
                        </div>
                    }
                    withInnerContainer
                >
                    <CalendarWidget isAdding={isCalendarAdding} setIsAdding={setIsCalendarAdding} isEditing={isCalendarEditing} />
                </Card>
            )
        },
        {
            id: "kanban",
            colSpan: 2,
            className: "max-h-[50vh]",
            wrapperStyle: trackGlow("kanban", activeTrack),
            content: (
                <ApplicationsKanbanCard
                    key={activeTrack}
                    track={activeTrack}
                    apps={activeApps}
                    loading={activeLoading}
                    onAdd={() => setIsAdding(true)}
                    onStatusChange={handleStatusChange}
                    onItemClick={setDetailAppId}
                    onBulkMoved={() => invalidateApps()}
                />
            )
        },
        {
            id: "new-postings",
            colSpan: 1,
            wrapperStyle: trackGlow("new-postings", activeTrack),
            content: <NewPostingsCard key={activeTrack} track={activeTrack} />
        },
        {
            id: "watchlists",
            colSpan: 1,
            wrapperStyle: trackGlow("watchlists", activeTrack),
            content: <WatchlistsCard key={activeTrack} track={activeTrack} />
        },
        {
            id: "conn-status",
            colSpan: 2,
            content: (
                <Card
                    title="Account Status"
                    icon={Mail}
                    iconColorClass="text-purple-400"
                >
                    <div className="flex flex-col gap-3">
                        <div className="flex items-center gap-2.5 bg-black/20 px-3 py-2 border border-white/5 rounded-xl">
                            {session?.user?.image ? (
                                <img src={session.user.image} className="w-8 h-8 rounded-full border border-slate-700/50" alt="avatar" />
                            ) : (
                                <div className="w-8 h-8 rounded-full bg-slate-800 flex items-center justify-center border border-slate-700/50">
                                    <Mail className="w-4 h-4 text-slate-400" />
                                </div>
                            )}
                            <div className="flex flex-col min-w-0">
                                <span className="text-sm font-semibold text-slate-200 truncate leading-tight">{session?.user?.name || "Connected User"}</span>
                                <span className="text-xs text-slate-500 truncate leading-tight">{session?.user?.email}</span>
                            </div>
                        </div>
                        <div className="flex flex-row gap-2">
                            <button onClick={scanInbox} disabled={isScanning} className="flex-1 flex items-center justify-center gap-1.5 px-2 py-2 bg-blue-500/10 hover:bg-blue-500/20 active:scale-95 border border-blue-500/20 rounded-lg text-xs font-semibold transition-all text-blue-300 disabled:opacity-50" title="Scan last 6 months of Gmail for application emails">
                                <Inbox className={`w-3.5 h-3.5 shrink-0 ${isScanning ? "animate-pulse" : ""}`} /> <span className="truncate">{isScanning ? "Scanning…" : "Scan Inbox"}</span>
                            </button>
                            <button onClick={() => syncFromGcal(false)} disabled={isSyncing} className="flex-1 flex items-center justify-center gap-1.5 px-2 py-2 bg-emerald-500/10 hover:bg-emerald-500/20 active:scale-95 border border-emerald-500/20 rounded-lg text-xs font-semibold transition-all text-emerald-300 disabled:opacity-50" title="Pull changes from Google Calendar">
                                <RotateCw className={`w-3.5 h-3.5 shrink-0 ${isSyncing ? "animate-spin" : ""}`} /> <span className="truncate">{isSyncing ? "Syncing…" : "Sync Gcal"}</span>
                            </button>
                            <button onClick={() => invalidateApps()} disabled={activeLoading} className="flex-1 flex items-center justify-center gap-1.5 px-2 py-2 bg-white/5 hover:bg-white/10 active:scale-95 border border-white/10 rounded-lg text-xs font-semibold transition-all text-slate-200 disabled:opacity-50" title="Refresh application list">
                                <RefreshCw className={`w-3.5 h-3.5 shrink-0 ${activeLoading ? "animate-spin" : ""}`} /> <span className="truncate">Ping Status</span>
                            </button>
                        </div>
                    </div>
                </Card>
            )
        }
    ];

    return (
        <Scrollbar className="w-full h-full pb-8">
            <Section title="Applications Pipeline" description="Auto-syncs via Gmail & Pub/Sub API">
                {!session ? (
                    <div className="mt-8 flex flex-col items-center justify-center h-80 gap-5 p-12 bg-black/20 border border-white/5 rounded-3xl max-w-xl mx-auto text-center backdrop-blur-md">
                        <div className="p-4 bg-blue-500/10 rounded-full">
                            <Mail className="w-12 h-12 text-blue-400" />
                        </div>
                        <div>
                            <h3 className="text-2xl font-bold bg-clip-text text-transparent bg-linear-to-r from-slate-100 to-slate-400">Connect to Pipeline</h3>
                            <p className="text-sm text-slate-400 mt-2 leading-relaxed max-w-sm mx-auto">Authorize Google to enable live Pub/Sub polling. Incoming emails are instantly parsed via Gemini 3 Flash to update your kanban statuses seamlessly.</p>
                        </div>
                        <button
                            onClick={() => signIn("google")}
                            className="mt-2 flex items-center gap-2 px-8 py-3 bg-blue-600 hover:bg-blue-500 active:scale-95 text-white rounded-xl transition-all font-semibold shadow-xl shadow-blue-500/20 cursor-pointer"
                        >
                            Connect Workspace
                        </button>
                    </div>
                ) : (
                    <>
                        {/* Track switch — flips the kanban + discovery cards between
                            tracks. Interviews + Account Status below are shared. */}
                        <div className="px-6 mt-4 flex items-center gap-2" role="tablist" aria-label="Application track">
                            {TRACKS.map(t => {
                                const isActive = t.id === activeTrack;
                                const Icon = t.icon;
                                return (
                                    <button
                                        key={t.id}
                                        role="tab"
                                        aria-selected={isActive}
                                        onClick={() => setApplicationsTrack(t.id)}
                                        className={`flex items-center gap-2 px-4 py-2 rounded-xl border text-sm font-semibold transition-all cursor-pointer ${isActive ? t.activeClass : "bg-black/30 border-white/10 text-white/50 hover:text-white/80 hover:border-white/20"}`}
                                    >
                                        <Icon className="w-4 h-4" />
                                        {t.label}
                                    </button>
                                );
                            })}
                        </div>
                        <div className="mt-4">
                            <CardGrid items={pipelineCards} columns={2} />
                        </div>
                    </>
                )}
            </Section>
            <AddApplicationModal
                open={isAdding}
                onClose={() => setIsAdding(false)}
                onCreated={() => invalidateApps()}
                defaultTrack={activeTrack}
            />
            {detailAppId && (
                <ApplicationDetailOverlay
                    applicationId={detailAppId}
                    onClose={() => setDetailAppId(null)}
                />
            )}
        </Scrollbar>
    );
};
