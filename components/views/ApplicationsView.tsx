import React, { useState, useEffect } from "react";
import { Section } from "../Section";
import { Loader2, Mail, RefreshCw, Calendar as CalendarIcon, Plus } from "lucide-react";
import { useSession, signIn } from "next-auth/react";
import { CalendarWidget } from "../widgets/CalendarWidget";
import { KanbanWidget, KanbanColumnDef } from "../widgets/KanbanWidget";
import { CardGrid, CardItem } from "../grids/CardGrid";
import { Card } from "../ui/Card";

interface AppRecord {
    id: string;
    company: string;
    role: string | null;
    status: string;
    nextSteps: string | null;
    lastUpdateAt: string;
}

const pipelineColumns: KanbanColumnDef[] = [
    { id: "applied", title: "Applied", statuses: ["APPLIED", "UPDATED"], colorClass: "bg-blue-500/20 text-blue-400 border border-blue-500/20" },
    { id: "assessment", title: "Assessment", statuses: ["ASSESSMENT"], colorClass: "bg-purple-500/20 text-purple-400 border border-purple-500/20" },
    { id: "interviewing", title: "Interviewing", statuses: ["INTERVIEW_REQUESTED", "INTERVIEW"], colorClass: "bg-amber-500/20 text-amber-500 border border-amber-500/20" },
    { id: "offer", title: "Offer", statuses: ["OFFER"], colorClass: "bg-emerald-500/20 text-emerald-400 border border-emerald-500/20" },
    { id: "archive", title: "Archive", statuses: ["REJECTED"], colorClass: "bg-slate-500/20 text-slate-400 border border-slate-500/20" }
];

export const ApplicationsView: React.FC = () => {
    const { data: session, status } = useSession();
    const [apps, setApps] = useState<AppRecord[]>([]);
    const [loading, setLoading] = useState(false);
    const [isCalendarAdding, setIsCalendarAdding] = useState(false);

    const fetchApps = async () => {
        if (!session) return;
        setLoading(true);
        try {
            const res = await fetch("/api/applications");
            const data = await res.json();
            if (data.applications) {
                setApps(data.applications);
            }
        } catch (e) {
            console.error(e);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        if (session) {
            fetchApps();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [session]);

    if (status === "loading") {
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
            id: "conn-status",
            colSpan: 3,
            hFit: true,
            content: (
                <Card 
                    title="Account Status" 
                    icon={Mail} 
                    iconColorClass="text-purple-400"
                    action={
                        <button onClick={fetchApps} disabled={loading} className="flex items-center gap-2 px-4 py-2 bg-white/5 hover:bg-white/10 active:scale-95 border border-white/10 rounded-lg text-xs font-semibold transition-all text-slate-200 disabled:opacity-50">
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
                        <div className="flex flex-col">
                            <span className="text-sm font-semibold text-slate-200 truncate">{session?.user?.name || "Connected User"}</span>
                            <span className="text-xs text-slate-500 truncate">{session?.user?.email}</span>
                        </div>
                    </div>
                </Card>
            )
        },
        {
            id: "kanban",
            colSpan: 1,
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
        }
    ];

    return (
        <div className="w-full h-full overflow-y-auto pb-8">
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
        </div>
    );
};
