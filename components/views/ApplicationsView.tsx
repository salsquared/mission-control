import React, { useState, useCallback, useRef, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Section } from "../Section";
import { Loader2, Mail, RefreshCw, Calendar as CalendarIcon, Plus, Inbox, RotateCw, Pencil } from "lucide-react";
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
import { WatchlistsCard } from "../cards/WatchlistsCard";
import { NewPostingsCard } from "../cards/NewPostingsCard";
import { ApplicationsKanbanCard, AppRecord } from "../cards/ApplicationsKanbanCard";

export const ApplicationsView: React.FC = () => {
    const { data: session, status } = useSession();
    const [isCalendarAdding, setIsCalendarAdding] = useState(false);
    const [isCalendarEditing, setIsCalendarEditing] = useState(false);
    const [isScanning, setIsScanning] = useState(false);
    const [isSyncing, setIsSyncing] = useState(false);
    const [isAdding, setIsAdding] = useState(false);
    const [detailAppId, setDetailAppId] = useState<string | null>(null);

    // Track first-time authentication so background session revalidations
    // (window focus, periodic refetch, cross-device signin) don't unmount
    // the whole subtree when status briefly flips back through "loading".
    const hasEverAuthedRef = useRef(false);
    if (status === "authenticated") hasEverAuthedRef.current = true;

    const queryClient = useQueryClient();
    const { data: appsData, isLoading: loading } = useQuery({
        queryKey: queryKeys.applications,
        queryFn: () => api.applications.list(),
        enabled: Boolean(session),
    });
    const apps: AppRecord[] = (appsData?.applications ?? []) as unknown as AppRecord[];

    const invalidateApps = useCallback(
        () => queryClient.invalidateQueries({ queryKey: queryKeys.applications }),
        [queryClient]
    );
    useServerEvents('Application', invalidateApps);
    useServerEvents('CalendarEvent', invalidateApps);

    const handleStatusChange = useCallback(async (id: string, newStatus: string) => {
        const prev = queryClient.getQueryData(queryKeys.applications);
        queryClient.setQueryData(queryKeys.applications, (old: any) => ({
            applications: (old?.applications ?? []).map((a: any) =>
                a.id === id ? { ...a, status: newStatus, lastUpdateAt: new Date().toISOString() } : a
            ),
        }));
        try {
            await api.applications.update({ id, status: newStatus as any });
            queryClient.invalidateQueries({ queryKey: ['application-events'] });
        } catch (e: any) {
            queryClient.setQueryData(queryKeys.applications, prev);
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

    const pipelineCards: CardItem[] = [
        {
            id: "kanban",
            colSpan: 3,
            className: "max-h-[50vh]",
            content: (
                <ApplicationsKanbanCard
                    apps={apps}
                    loading={loading}
                    onAdd={() => setIsAdding(true)}
                    onStatusChange={handleStatusChange}
                    onItemClick={setDetailAppId}
                />
            )
        },
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
            id: "conn-status",
            colSpan: 1,
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
                            <button onClick={() => invalidateApps()} disabled={loading} className="flex-1 flex items-center justify-center gap-1.5 px-2 py-2 bg-white/5 hover:bg-white/10 active:scale-95 border border-white/10 rounded-lg text-xs font-semibold transition-all text-slate-200 disabled:opacity-50" title="Refresh application list">
                                <RefreshCw className={`w-3.5 h-3.5 shrink-0 ${loading ? "animate-spin" : ""}`} /> <span className="truncate">Ping Status</span>
                            </button>
                        </div>
                    </div>
                </Card>
            )
        }
    ];

    const discoveryCards: CardItem[] = [
        { id: "watchlists", content: <WatchlistsCard /> },
        { id: "new-postings", content: <NewPostingsCard /> },
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
                    <div className="mt-4">
                        <CardGrid items={pipelineCards} />
                    </div>
                )}
            </Section>
            {session && (
                <Section title="Job Discovery" description="Watchlists + new postings — scheduler ticks every 10 min; each watchlist crawls on its own cadence">
                    <div className="mt-4">
                        <CardGrid items={discoveryCards} columns={2} />
                    </div>
                </Section>
            )}
            <AddApplicationModal
                open={isAdding}
                onClose={() => setIsAdding(false)}
                onCreated={() => invalidateApps()}
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
