import React, { useState, useEffect } from "react";
import { Section } from "../Section";
import { Loader2, Mail, RefreshCw } from "lucide-react";
import { useSession, signIn } from "next-auth/react";

interface AppRecord {
    id: string;
    company: string;
    role: string | null;
    status: string;
    nextSteps: string | null;
    lastUpdateAt: string;
}

export const ApplicationsView: React.FC = () => {
    const { data: session, status } = useSession();
    const [apps, setApps] = useState<AppRecord[]>([]);
    const [loading, setLoading] = useState(false);

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

    const getColumnApps = (statuses: string[]) => apps.filter(a => statuses.includes(a.status));

    const KanbanColumn = ({ title, statuses, colorClass }: { title: string, statuses: string[], colorClass: string }) => {
        const columnApps = getColumnApps(statuses);
        return (
            <div className="flex flex-col gap-3 min-w-[300px] w-[300px] shrink-0 bg-slate-900 border border-slate-800 rounded-xl p-4 h-full overflow-y-auto">
                <div className="flex justify-between items-center mb-4 sticky top-0 bg-slate-900 z-10 pb-2">
                    <h4 className="font-semibold text-slate-200">{title}</h4>
                    <span className={`text-xs px-2.5 py-0.5 rounded-full font-medium ${colorClass}`}>{columnApps.length}</span>
                </div>
                {columnApps.length === 0 ? (
                    <div className="text-center text-sm text-slate-600 my-auto py-8">No applications</div>
                ) : (
                    columnApps.map(app => (
                        <div key={app.id} className="bg-slate-800 border border-slate-700/50 rounded-xl p-4 shadow-xl hover:border-slate-500 hover:bg-slate-800/80 transition-all cursor-default relative overflow-hidden group">
                            <div className={`absolute top-0 left-0 w-1 h-full ${colorClass.split(" ")[0]} opacity-50`}></div>
                            <h5 className="font-bold text-slate-100 truncate flex items-center gap-2">
                                {app.company}
                            </h5>
                            <p className="text-sm text-slate-400 mt-0.5 line-clamp-1">{app.role || "Unknown Role"}</p>
                            {app.nextSteps && (
                                <div className="mt-3 text-xs text-slate-400 leading-relaxed bg-slate-900/40 p-2.5 rounded-lg border border-slate-700/50 line-clamp-3">
                                    {app.nextSteps}
                                </div>
                            )}
                            <div className="mt-3 text-[10px] text-slate-500 uppercase tracking-widest flex justify-between items-center pt-2 border-t border-slate-700/50">
                                <span>{new Date(app.lastUpdateAt).toLocaleDateString()}</span>
                                <span className={colorClass + " bg-transparent px-0 rounded-none font-bold"}>{app.status}</span>
                            </div>
                        </div>
                    ))
                )}
            </div>
        );
    };

    if (status === "loading") {
        return (
            <div className="w-full h-full flex items-center justify-center">
                <Loader2 className="w-8 h-8 text-blue-500 animate-spin" />
            </div>
        );
    }

    return (
        <div className="w-full h-full overflow-hidden flex flex-col relative text-sm pb-[100px] pt-4 px-4 bg-background transition-colors duration-500">
            <Section title="Applications Pipeline" description="Auto-syncs via Gmail & Pub/Sub API">
                {!session ? (
                    <div className="mt-8 flex flex-col items-center justify-center h-80 gap-5 p-12 bg-slate-800/50 border border-slate-700/40 rounded-3xl max-w-xl mx-auto text-center backdrop-blur-md">
                        <div className="p-4 bg-blue-500/10 rounded-full">
                            <Mail className="w-12 h-12 text-blue-400" />
                        </div>
                        <div>
                            <h3 className="text-2xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-slate-100 to-slate-400">Connect to Pipeline</h3>
                            <p className="text-sm text-slate-400 mt-2 leading-relaxed max-w-sm mx-auto">Authorize Google to enable live Pub/Sub polling. Incoming emails are instantly parsed via Gemini 3 Flash to update your kanban statuses seamlessly.</p>
                        </div>
                        <button
                            onClick={() => signIn("google")}
                            className="mt-2 flex items-center gap-2 px-8 py-3 bg-blue-600 hover:bg-blue-500 active:scale-95 text-white rounded-xl transition-all font-semibold shadow-xl shadow-blue-500/20"
                        >
                            Connect Workspace
                        </button>
                    </div>
                ) : (
                    <div className="flex flex-col h-[calc(100vh-280px)] overflow-hidden w-full mt-4">
                        {/* Header Toolbar */}
                        <div className="flex items-center justify-between mb-4 bg-slate-900/30 p-3 rounded-2xl border border-white/5 backdrop-blur-sm">
                            <div className="flex items-center gap-3">
                                {session.user?.image && <img src={session.user.image} className="w-8 h-8 rounded-full border border-slate-700/50" alt="avatar" />}
                                <div className="text-xs">
                                    <span className="text-slate-400">Connected: </span>
                                    <span className="font-semibold text-slate-200">{session.user?.email}</span>
                                </div>
                            </div>
                            <button onClick={fetchApps} disabled={loading} className="flex items-center gap-2 px-4 py-2 bg-slate-800 hover:bg-slate-700 active:scale-95 border border-slate-700 rounded-lg text-xs font-semibold transition-all text-slate-200 disabled:opacity-50">
                                <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} /> Ping Status
                            </button>
                        </div>
                        
                        {/* Kanban Board Container */}
                        <div className="flex-1 overflow-x-auto overflow-y-hidden rounded-2xl border border-slate-800/80 bg-slate-950/20 shadow-inner custom-scrollbar">
                             {loading && apps.length === 0 ? (
                                 <div className="flex items-center justify-center h-full w-full">
                                     <Loader2 className="w-10 h-10 text-blue-500/50 animate-spin" />
                                 </div>
                             ) : (
                                <div className="flex h-full p-6 space-x-6 min-w-max">
                                    <KanbanColumn title="Applied" statuses={["APPLIED", "UPDATED"]} colorClass="bg-blue-500/20 text-blue-400 border border-blue-500/20" />
                                    <KanbanColumn title="Assessment" statuses={["ASSESSMENT"]} colorClass="bg-purple-500/20 text-purple-400 border border-purple-500/20" />
                                    <KanbanColumn title="Interviewing" statuses={["INTERVIEW_REQUESTED", "INTERVIEW"]} colorClass="bg-amber-500/20 text-amber-500 border border-amber-500/20" />
                                    <KanbanColumn title="Offer" statuses={["OFFER"]} colorClass="bg-emerald-500/20 text-emerald-400 border border-emerald-500/20" />
                                    <KanbanColumn title="Archive" statuses={["REJECTED"]} colorClass="bg-slate-500/20 text-slate-400 border border-slate-500/20" />
                                </div>
                             )}
                        </div>
                    </div>
                )}
            </Section>
        </div>
    );
};
