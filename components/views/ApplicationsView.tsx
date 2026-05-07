import React, { useState, useCallback, useRef } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { Section } from "../Section";
import { Loader2, Mail, RefreshCw, Calendar as CalendarIcon, Plus, Radio } from "lucide-react";
import { useSession, signIn } from "next-auth/react";
import { CalendarWidget } from "../widgets/CalendarWidget";
import { KanbanWidget, KanbanColumnDef } from "../widgets/KanbanWidget";
import { CardGrid, CardItem } from "../grids/CardGrid";
import { Card } from "../ui/Card";
import { Scrollbar } from "../ui/Scrollbar";
import { useServerEvents } from "@/hooks/useServerEvents";
import { api, queryKeys } from "@/lib/api-client";
import { ApplicationStepper } from "../widgets/applications/ApplicationStepper";
import { ApplicationEmailList, ApplicationEmailItem } from "../widgets/applications/ApplicationEmailList";
import { ApplicationNextStep } from "../widgets/applications/ApplicationNextStep";

interface AppRecord {
    id: string;
    company: string;
    role: string | null;
    status: string;
    nextSteps: string | null;
    nextStepAt: string | null;
    lastUpdateAt: string;
    emails: ApplicationEmailItem[];
}

type AppKanbanColumnDef = KanbanColumnDef<AppRecord> & { statuses: string[] };

const pipelineColumns: AppKanbanColumnDef[] = [
    { id: "applied", title: "Applied", statuses: ["APPLIED", "UPDATED"], filterFn: (app) => ["APPLIED", "UPDATED"].includes(app.status), defaultTargetStatus: "APPLIED", colorClass: "bg-blue-500/20 text-blue-400 border border-blue-500/20" },
    { id: "assessment", title: "Assessment", statuses: ["ASSESSMENT"], filterFn: (app) => ["ASSESSMENT"].includes(app.status), defaultTargetStatus: "ASSESSMENT", colorClass: "bg-purple-500/20 text-purple-400 border border-purple-500/20" },
    { id: "interviewing", title: "Interviewing", statuses: ["INTERVIEW_REQUESTED", "INTERVIEW"], filterFn: (app) => ["INTERVIEW_REQUESTED", "INTERVIEW"].includes(app.status), defaultTargetStatus: "INTERVIEW", colorClass: "bg-amber-500/20 text-amber-500 border border-amber-500/20" },
    { id: "offer", title: "Offer", statuses: ["OFFER"], filterFn: (app) => ["OFFER"].includes(app.status), defaultTargetStatus: "OFFER", colorClass: "bg-emerald-500/20 text-emerald-400 border border-emerald-500/20" },
    { id: "archive", title: "Archive", statuses: ["REJECTED"], filterFn: (app) => ["REJECTED"].includes(app.status), defaultTargetStatus: "REJECTED", colorClass: "bg-slate-500/20 text-slate-400 border border-slate-500/20" }
];

function relativeShort(iso: string): string {
    const ms = Date.now() - new Date(iso).getTime();
    const m = Math.floor(ms / 60_000);
    if (m < 1) return "just now";
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h`;
    const d = Math.floor(h / 24);
    return `${d}d`;
}

function watchSummary(watch: { expiresAt: string } | null | undefined): string {
    if (!watch) return "No Pub/Sub watch installed";
    const ms = new Date(watch.expiresAt).getTime() - Date.now();
    if (ms <= 0) return "Watch expired";
    const days = Math.floor(ms / (24 * 60 * 60 * 1000));
    const hours = Math.floor((ms % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
    if (days >= 1) return `Watch active · expires in ${days}d`;
    return `Watch active · expires in ${hours}h`;
}

export const ApplicationsView: React.FC = () => {
    const { data: session, status } = useSession();
    const [isCalendarAdding, setIsCalendarAdding] = useState(false);

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

    const { data: watchData } = useQuery({
        queryKey: ['gmail-watch'],
        queryFn: () => api.gmailWatch.get(),
        enabled: Boolean(session),
    });

    const installWatch = useMutation({
        mutationFn: () => api.gmailWatch.install(),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ['gmail-watch'] }),
    });

    const invalidateApps = useCallback(
        () => queryClient.invalidateQueries({ queryKey: queryKeys.applications }),
        [queryClient]
    );
    useServerEvents('Application', invalidateApps);
    useServerEvents('CalendarEvent', invalidateApps);

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
        const emailCount = app.emails.length;
        const lastEmailAt = app.emails[0]?.receivedAt;

        return (
            <div key={app.id} className="bg-black/40 border border-white/5 rounded-xl p-4 shadow-xl hover:border-white/20 hover:bg-black/60 transition-all cursor-default relative overflow-hidden group">
                <div className={`absolute top-0 left-0 w-1 h-full ${colorClass.split(" ")[0]} opacity-50`}></div>
                <h5 className="font-bold text-slate-100 truncate flex items-center gap-2">
                    {app.company}
                </h5>
                <p className="text-sm text-slate-400 mt-0.5 line-clamp-1">{app.role || "Unknown Role"}</p>

                <ApplicationStepper status={app.status} />
                <ApplicationNextStep nextStepAt={app.nextStepAt} />

                {app.nextSteps && (
                    <div className="mt-3 text-xs text-slate-400 leading-relaxed bg-black/20 p-2.5 rounded-lg border border-white/5 line-clamp-3">
                        {app.nextSteps}
                    </div>
                )}

                <ApplicationEmailList emails={app.emails} />

                <div className="mt-3 text-[10px] text-slate-500 uppercase tracking-widest flex justify-between items-center pt-2 border-t border-white/5">
                    <span>
                        {emailCount > 0
                            ? `${emailCount} email${emailCount === 1 ? "" : "s"} · ${relativeShort(lastEmailAt!)} ago`
                            : new Date(app.lastUpdateAt).toLocaleDateString()}
                    </span>
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
                        <button onClick={() => invalidateApps()} disabled={loading} className="flex items-center gap-2 px-4 py-2 bg-white/5 hover:bg-white/10 active:scale-95 border border-white/10 rounded-lg text-xs font-semibold transition-all text-slate-200 disabled:opacity-50">
                            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} /> Ping Status
                        </button>
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
                        <div className="flex flex-col flex-1 min-w-0">
                            <span className="text-sm font-semibold text-slate-200 truncate">{session?.user?.name || "Connected User"}</span>
                            <span className="text-xs text-slate-500 truncate">{session?.user?.email}</span>
                            <span className="text-[10px] text-slate-500 truncate flex items-center gap-1.5 mt-1">
                                <Radio className={`w-3 h-3 ${watchData?.watch ? "text-emerald-400" : "text-slate-600"}`} />
                                {watchSummary(watchData?.watch ?? null)}
                            </span>
                        </div>
                        <button
                            onClick={() => installWatch.mutate()}
                            disabled={installWatch.isPending}
                            className="text-[10px] uppercase tracking-wider font-bold px-2.5 py-1.5 bg-blue-500/10 hover:bg-blue-500/20 text-blue-300 border border-blue-400/20 rounded-md transition-colors disabled:opacity-50"
                        >
                            {installWatch.isPending ? "..." : (watchData?.watch ? "Renew" : "Install")}
                        </button>
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
