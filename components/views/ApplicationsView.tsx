import React, { useState, useCallback, useRef, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Section } from "../Section";
import { Loader2, Mail, RefreshCw, Calendar as CalendarIcon, Plus, Inbox, RotateCw, Pencil, Briefcase } from "lucide-react";
import { useAccount } from "@/hooks/useAccount";
import { useConnectGoogle } from "@/hooks/useConnectGoogle";
import { CalendarWidget } from "../widgets/CalendarWidget";
import { CardCanvas, type CardItem } from "../grids/CardCanvas";
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

// The Kanban / New Postings / Watchlists cards deliberately carry NO per-track
// accent. They previously took a radial `trackGradient` wash plus a colored
// `trackShadow`, both keyed to the active track; those are gone in favour of
// CardCanvas's canonical chrome, which every other card on every other dash
// already uses. The track is still legible from the switcher above and from the
// cards' own contents, so the glow was decoration, not signal. Re-adding it
// means reintroducing the one place in the app where a card overrides its
// background and frame shadow — do that only deliberately.

export const ApplicationsView: React.FC = () => {
    // Edge-trusted: a verified viewer is always present past Cloudflare Access,
    // so the list queries gate on viewer presence (not a session) and there's no
    // access wall. `googleConnected` drives only the non-blocking reconnect
    // affordance in the Account Status card — and only for the owner.
    const { user, role, googleConnected, isLoading: accountLoading } = useAccount();
    // Navigation, not next-auth's fetch-based `signIn` — see the hook for why.
    const connectGoogle = useConnectGoogle();

    // Google-backed controls are OWNER-ONLY (docs/multi-user-crew.html P3.5 +
    // P3.7, decided in OQ6a): crew never connect Google, so every route below
    // that reaches `getGoogleAuthClient` either 403s or throws for them.
    //
    // Two things this deliberately is NOT:
    //   - NOT keyed on `googleConnected`. Crew have no `Account` row, so that
    //     flag is permanently false and is indistinguishable from the owner's
    //     "not connected yet" — gating on it would show crew a Connect button
    //     forever, inviting them into a scope grant that is an explicit v1
    //     non-goal (OQ6a).
    //   - NOT `role !== 'crew'`. `role` is `undefined` until /api/account
    //     resolves; the unknown-role window must behave like crew so no
    //     owner-only request can leave the client before we know who is asking.
    //     (The owner never sees these controls flash in late either: the
    //     spinner below covers the first resolve, and a background refetch
    //     keeps the cached role.)
    const isOwner = role === 'owner';
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

    // Track first owner resolution so a background account refetch can't flip us
    // back into the full-page spinner once we've rendered the pipeline.
    const hasEverResolvedRef = useRef(false);
    if (user) hasEverResolvedRef.current = true;

    const queryClient = useQueryClient();
    // Both tracks' apps stay queried even though only one renders at a time:
    // it keeps the dual-cache optimistic handleStatusChange and the kanban's
    // "move to other track" bulk action working without a rewrite, and the
    // switch flips instantly (no refetch flash). The discovery cards fetch
    // their own per-track data internally and now mount once, not twice.
    const { data: appsData, isLoading: loading } = useQuery({
        queryKey: queryKeys.applications,
        queryFn: () => api.applications.list({ track: 'career' }),
        enabled: Boolean(user),
    });
    const { data: sideAppsData, isLoading: sideLoading } = useQuery({
        queryKey: [...queryKeys.applications, 'side'] as const,
        queryFn: () => api.applications.list({ track: 'side' }),
        enabled: Boolean(user),
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
        if (!user || !isOwner) return;
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
    }, [user, isOwner, queryClient]);

    // Background poll while the view is mounted. 5-min cadence so we don't
    // hammer Google; the syncToken makes each tick cheap. Silent toasts —
    // user only sees noise when they hit "Sync now" themselves.
    //
    // OWNER-ONLY, and the timer is never ARMED for anyone else — the effect
    // returns before `setInterval`, rather than arming a timer whose callback
    // bails. This is the one item in P3.7 that is an OWNER-facing defect: for
    // crew, `/api/applications/events/sync` reaches `getGoogleAuthClient`, which
    // throws on a missing `Account` row; `syncFromGcal` swallows that silently
    // (`silent = true` suppresses the toast), so crew would see nothing while
    // every crew tab wrote a warning into the OWNER's 500-deep log ring buffer
    // every five minutes, indefinitely, evicting real signal. `isOwner` is in
    // the deps so the timer arms the moment the role resolves to owner, and is
    // torn down if it ever stops being owner.
    useEffect(() => {
        if (!user || !isOwner) return;
        const id = setInterval(() => syncFromGcal(true), 5 * 60 * 1000);
        return () => clearInterval(id);
    }, [user, isOwner, syncFromGcal]);

    const scanInbox = useCallback(async () => {
        // Owner-only route (`/api/applications/backfill`, `requireOwner`).
        // Guard the CALL, not just the button that is already hidden below.
        if (!isOwner) return;
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
    }, [isOwner, invalidateApps]);

    if (accountLoading && !hasEverResolvedRef.current) {
        return (
            <div className="w-full h-full flex items-center justify-center">
                <Loader2 className="w-8 h-8 text-blue-500 animate-spin" />
            </div>
        );
    }

    // Single card stack for the active track. In a 2-column CardCanvas,
    // colSpan:2 = full width (colSpan === columns → `1 / -1`) and colSpan:1 =
    // half. Packing preserves DOM order, so the order is simply: Interviews (full) → Kanban (full) → [New Postings · Watchlists]
    // → Account Status (full). The kanban + discovery cards carry key={activeTrack}
    // so flipping the switch remounts them (resets page / search / select state)
    // while the CardItem-keyed frame stays put.
    const pipelineCards: CardItem[] = [
        {
            id: "calendar",
            colSpan: 2,
            className: "h-[40vh]",
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
            className: "h-[50vh]",
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
            content: <NewPostingsCard key={activeTrack} track={activeTrack} />
        },
        {
            id: "watchlists",
            colSpan: 1,
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
                            <div className="w-8 h-8 rounded-full bg-slate-800 flex items-center justify-center border border-slate-700/50">
                                <Mail className="w-4 h-4 text-slate-400" />
                            </div>
                            <div className="flex flex-col min-w-0 flex-1">
                                <span className="text-sm font-semibold text-slate-200 truncate leading-tight">{user?.email ?? "Signed in"}</span>
                                {/* The connection line is part of the same
                                    invitation as the button beside it: for crew
                                    a permanent amber "Google not connected"
                                    reads as a setup step they are expected to
                                    finish. Owner-only, same condition. */}
                                {isOwner && (
                                    <span className={`text-xs truncate leading-tight ${googleConnected ? "text-emerald-400" : "text-amber-400"}`}>
                                        {googleConnected ? "Google connected" : "Google not connected"}
                                    </span>
                                )}
                            </div>
                            {isOwner && !googleConnected && (
                                <button
                                    onClick={connectGoogle}
                                    className="shrink-0 px-3 py-1.5 bg-blue-500/10 hover:bg-blue-500/20 active:scale-95 border border-blue-500/20 rounded-lg text-xs font-semibold text-blue-300 transition-all"
                                    title="Reconnect Google to enable inbox scanning and calendar sync"
                                >
                                    Connect
                                </button>
                            )}
                        </div>
                        <div className="flex flex-row gap-2">
                            {/* Scan Inbox → /api/applications/backfill and Sync
                                Gcal → /api/applications/events/sync are both
                                owner-only. Hidden, not disabled: a greyed-out
                                control still reads as "yours, later", and these
                                never become available to crew. Ping Status is a
                                pure cache invalidation, so it stays for all. */}
                            {isOwner && (
                                <button onClick={scanInbox} disabled={isScanning} className="flex-1 flex items-center justify-center gap-1.5 px-2 py-2 bg-blue-500/10 hover:bg-blue-500/20 active:scale-95 border border-blue-500/20 rounded-lg text-xs font-semibold transition-all text-blue-300 disabled:opacity-50" title="Scan last 6 months of Gmail for application emails">
                                    <Inbox className={`w-3.5 h-3.5 shrink-0 ${isScanning ? "animate-pulse" : ""}`} /> <span className="truncate">{isScanning ? "Scanning…" : "Scan Inbox"}</span>
                                </button>
                            )}
                            {isOwner && (
                                <button onClick={() => syncFromGcal(false)} disabled={isSyncing} className="flex-1 flex items-center justify-center gap-1.5 px-2 py-2 bg-emerald-500/10 hover:bg-emerald-500/20 active:scale-95 border border-emerald-500/20 rounded-lg text-xs font-semibold transition-all text-emerald-300 disabled:opacity-50" title="Pull changes from Google Calendar">
                                    <RotateCw className={`w-3.5 h-3.5 shrink-0 ${isSyncing ? "animate-spin" : ""}`} /> <span className="truncate">{isSyncing ? "Syncing…" : "Sync Gcal"}</span>
                                </button>
                            )}
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
            {/* The subtitle is role-dependent for the same reason as the
                controls: crew have no Gmail ingest (OQ6a), so promising them an
                auto-syncing pipeline describes a feature they do not have. */}
            <Section
                title="Applications Pipeline"
                description={isOwner ? "Auto-syncs via Gmail & Pub/Sub API" : "Track applications and postings from your watchlists"}
            >
                {/* No access wall: a verified viewer is always present past the
                    edge. The track switch + pipeline render directly; Google
                    connection state is surfaced (non-blocking) in the Account
                    Status card, and only for the owner. */}
                {/* Track switch — flips the kanban + discovery cards between
                    tracks. Interviews + Account Status below are shared. */}
                <div className="mt-4 flex items-center gap-2" role="tablist" aria-label="Application track">
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
                    <CardCanvas items={pipelineCards} columns={2} />
                </div>
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
