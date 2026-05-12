import React, { useState, useCallback, useRef, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Section } from "../Section";
import { Loader2, Mail, RefreshCw, Calendar as CalendarIcon, Plus, Inbox, RotateCw } from "lucide-react";
import { useSession, signIn } from "next-auth/react";
import { CalendarWidget } from "../widgets/CalendarWidget";
import { KanbanWidget, KanbanColumnDef } from "../widgets/KanbanWidget";
import { CardGrid, CardItem } from "../grids/CardGrid";
import { Card } from "../ui/Card";
import { Scrollbar } from "../ui/Scrollbar";
import { useServerEvents } from "@/hooks/useServerEvents";
import { api, queryKeys } from "@/lib/api-client";
import { toastStore } from "@/lib/toast-store";

interface AppRecord {
    id: string;
    company: string;
    role: string | null;
    status: string;
    nextSteps: string | null;
    lastUpdateAt: string;
}

type AppKanbanColumnDef = KanbanColumnDef<AppRecord> & { statuses: string[] };

const pipelineColumns: AppKanbanColumnDef[] = [
    { id: "applied", title: "Applied", statuses: ["APPLIED", "UPDATED"], filterFn: (app) => ["APPLIED", "UPDATED"].includes(app.status), defaultTargetStatus: "APPLIED", colorClass: "bg-blue-500/20 text-blue-400 border border-blue-500/20" },
    { id: "assessment", title: "Assessment", statuses: ["ASSESSMENT"], filterFn: (app) => ["ASSESSMENT"].includes(app.status), defaultTargetStatus: "ASSESSMENT", colorClass: "bg-purple-500/20 text-purple-400 border border-purple-500/20" },
    { id: "interviewing", title: "Interviewing", statuses: ["INTERVIEW_REQUESTED", "INTERVIEW"], filterFn: (app) => ["INTERVIEW_REQUESTED", "INTERVIEW"].includes(app.status), defaultTargetStatus: "INTERVIEW", colorClass: "bg-amber-500/20 text-amber-500 border border-amber-500/20" },
    { id: "offer", title: "Offer", statuses: ["OFFER"], filterFn: (app) => ["OFFER"].includes(app.status), defaultTargetStatus: "OFFER", colorClass: "bg-emerald-500/20 text-emerald-400 border border-emerald-500/20" },
    { id: "archive", title: "Archive", statuses: ["REJECTED"], filterFn: (app) => ["REJECTED"].includes(app.status), defaultTargetStatus: "REJECTED", colorClass: "bg-slate-500/20 text-slate-400 border border-slate-500/20" }
];

export const ApplicationsView: React.FC = () => {
    const { data: session, status } = useSession();
    const [isCalendarAdding, setIsCalendarAdding] = useState(false);
    const [isScanning, setIsScanning] = useState(false);
    const [isSyncing, setIsSyncing] = useState(false);

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
            const summary = `Scanned ${result.scanned} · ${result.created} new · ${result.updated} updated · ${result.skipped} skipped`;
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

    const renderKanbanItem = (app: AppRecord) => {
        const colDef = pipelineColumns.find(c => c.statuses.includes(app.status));
        const colorClass = colDef?.colorClass || "bg-slate-500/20 text-slate-400 border-none";

        return (
            <div key={app.id} className="bg-black/40 border border-white/5 rounded-xl p-4 shadow-xl hover:border-white/20 hover:bg-black/60 transition-all cursor-default relative overflow-hidden group">
                <div className={`absolute top-0 left-0 w-1 h-full ${colorClass.split(" ")[0]} opacity-50`}></div>
                <h5 className="font-bold text-slate-100 truncate flex items-center gap-2">
                    {app.company}
                </h5>
                <p className="text-sm text-slate-400 mt-0.5 line-clamp-1">{app.role || "Unknown Role"}</p>
                {app.nextSteps && (
                    <div className="mt-3 text-xs text-slate-400 leading-relaxed bg-black/20 p-2.5 rounded-lg border border-white/5 line-clamp-3">
                        {app.nextSteps}
                    </div>
                )}
                <div className="mt-3 text-[10px] text-slate-500 uppercase tracking-widest flex justify-between items-center pt-2 border-t border-white/5">
                    <span>{new Date(app.lastUpdateAt).toLocaleDateString()}</span>
                    <span className={colorClass + " bg-transparent px-0 rounded-none font-bold"}>{app.status}</span>
                </div>
            </div>
        );
    };

    const cards: CardItem[] = [
        {
            id: "kanban",
            colSpan: 1,
            className: "col-span-1 md:col-span-2 lg:col-span-1",
            content: (
                <Card 
                    title="Pipeline Kanban" 
                    icon={Mail} 
                    iconColorClass="text-blue-400"
                    withInnerContainer
                >
                    <KanbanWidget<AppRecord>
                        items={apps}
                        columns={pipelineColumns}
                        getStatus={(app) => app.status}
                        renderItem={renderKanbanItem}
                        loading={loading}
                        emptyText="No applications"
                    />
                </Card>
            )
        },
        {
            id: "calendar",
            colSpan: 2,
            content: (
                <Card 
                    title="Upcoming Interviews" 
                    icon={CalendarIcon} 
                    iconColorClass="text-emerald-400"
                    action={
                        <button
                            onClick={() => setIsCalendarAdding(!isCalendarAdding)}
                            className="p-1.5 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 rounded-lg transition-colors cursor-pointer"
                            title="Add Event"
                        >
                            <Plus className="w-4 h-4" />
                        </button>
                    }
                    withInnerContainer
                >
                    <CalendarWidget isAdding={isCalendarAdding} setIsAdding={setIsCalendarAdding} />
                </Card>
            )
        },
        {
            id: "conn-status",
            colSpan: 3,
            hFit: true,
            content: (
                <Card 
                    title="Account Status" 
                    icon={Mail} 
                    iconColorClass="text-purple-400"
                    action={
                        <div className="flex items-center gap-2">
                            <button onClick={scanInbox} disabled={isScanning} className="flex items-center gap-2 px-4 py-2 bg-blue-500/10 hover:bg-blue-500/20 active:scale-95 border border-blue-500/20 rounded-lg text-xs font-semibold transition-all text-blue-300 disabled:opacity-50" title="Scan last 6 months of Gmail for application emails">
                                <Inbox className={`w-3.5 h-3.5 ${isScanning ? "animate-pulse" : ""}`} /> {isScanning ? "Scanning…" : "Scan Inbox"}
                            </button>
                            <button onClick={() => syncFromGcal(false)} disabled={isSyncing} className="flex items-center gap-2 px-4 py-2 bg-emerald-500/10 hover:bg-emerald-500/20 active:scale-95 border border-emerald-500/20 rounded-lg text-xs font-semibold transition-all text-emerald-300 disabled:opacity-50" title="Pull changes from Google Calendar">
                                <RotateCw className={`w-3.5 h-3.5 ${isSyncing ? "animate-spin" : ""}`} /> {isSyncing ? "Syncing…" : "Sync Gcal"}
                            </button>
                            <button onClick={() => invalidateApps()} disabled={loading} className="flex items-center gap-2 px-4 py-2 bg-white/5 hover:bg-white/10 active:scale-95 border border-white/10 rounded-lg text-xs font-semibold transition-all text-slate-200 disabled:opacity-50">
                                <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} /> Ping Status
                            </button>
                        </div>
                    }
                >
                    <div className="flex items-center gap-3 bg-black/20 p-4 border border-white/5 rounded-xl">
                        {session?.user?.image ? (
                            <img src={session.user.image} className="w-10 h-10 rounded-full border border-slate-700/50" alt="avatar" />
                        ) : (
                            <div className="w-10 h-10 rounded-full bg-slate-800 flex items-center justify-center border border-slate-700/50">
                                <Mail className="w-5 h-5 text-slate-400" />
                            </div>
                        )}
                        <div className="flex flex-col">
                            <span className="text-sm font-semibold text-slate-200 truncate">{session?.user?.name || "Connected User"}</span>
                            <span className="text-xs text-slate-500 truncate">{session?.user?.email}</span>
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
                    <div className="mt-4">
                        <CardGrid items={cards} />
                    </div>
                )}
            </Section>
        </Scrollbar>
    );
};
