"use client";
import React from "react";
import { Mail, Plus } from "lucide-react";
import { Card } from "../ui/Card";
import { KanbanWidget, KanbanColumnDef } from "../widgets/KanbanWidget";

export interface AppRecord {
    id: string;
    company: string;
    role: string | null;
    status: string;
    nextSteps: string | null;
    lastUpdateAt: string;
}

type AppKanbanColumnDef = KanbanColumnDef<AppRecord> & { statuses: string[] };

const pipelineColumns: AppKanbanColumnDef[] = [
    { id: "interested", title: "Interested", statuses: ["INTERESTED"], filterFn: (app) => ["INTERESTED"].includes(app.status), defaultTargetStatus: "INTERESTED", colorClass: "bg-cyan-500/20 text-cyan-400 border border-cyan-500/20" },
    { id: "applied", title: "Applied", statuses: ["APPLIED", "UPDATED"], filterFn: (app) => ["APPLIED", "UPDATED"].includes(app.status), defaultTargetStatus: "APPLIED", colorClass: "bg-blue-500/20 text-blue-400 border border-blue-500/20" },
    { id: "assessment", title: "Assessment", statuses: ["ASSESSMENT"], filterFn: (app) => ["ASSESSMENT"].includes(app.status), defaultTargetStatus: "ASSESSMENT", colorClass: "bg-purple-500/20 text-purple-400 border border-purple-500/20" },
    { id: "interviewing", title: "Interviewing", statuses: ["INTERVIEW_REQUESTED", "INTERVIEW"], filterFn: (app) => ["INTERVIEW_REQUESTED", "INTERVIEW"].includes(app.status), defaultTargetStatus: "INTERVIEW", colorClass: "bg-amber-500/20 text-amber-500 border border-amber-500/20" },
    { id: "offer", title: "Offer", statuses: ["OFFER"], filterFn: (app) => ["OFFER"].includes(app.status), defaultTargetStatus: "OFFER", colorClass: "bg-emerald-500/20 text-emerald-400 border border-emerald-500/20" },
    { id: "archive", title: "Archive", statuses: ["REJECTED"], filterFn: (app) => ["REJECTED"].includes(app.status), defaultTargetStatus: "REJECTED", colorClass: "bg-slate-500/20 text-slate-400 border border-slate-500/20" }
];

interface ApplicationsKanbanCardProps {
    apps: AppRecord[];
    loading: boolean;
    onAdd: () => void;
    onStatusChange: (id: string, newStatus: string) => void;
    onItemClick: (id: string) => void;
}

export const ApplicationsKanbanCard: React.FC<ApplicationsKanbanCardProps> = ({
    apps,
    loading,
    onAdd,
    onStatusChange,
    onItemClick,
}) => {
    const renderItem = (app: AppRecord) => {
        const colDef = pipelineColumns.find((c) => c.statuses.includes(app.status));
        const colorClass = colDef?.colorClass || "bg-slate-500/20 text-slate-400 border-none";

        return (
            <div
                key={app.id}
                onClick={() => onItemClick(app.id)}
                className="bg-black/40 border border-white/5 rounded-xl px-3 py-2 shadow-xl hover:border-white/20 hover:bg-black/60 transition-all relative overflow-hidden group"
            >
                <div className={`absolute top-0 left-0 w-1 h-full ${colorClass.split(" ")[0]} opacity-50`}></div>
                <h5 className="font-bold text-slate-100 truncate flex items-center gap-2 leading-tight">
                    {app.company}
                </h5>
                <p className="text-sm text-slate-400 line-clamp-1 leading-snug">{app.role || "Unknown Role"}</p>
                {app.nextSteps && (
                    <div className="mt-1.5 text-xs text-slate-400 leading-snug bg-black/20 px-2 py-1.5 rounded-md border border-white/5 line-clamp-2">
                        {app.nextSteps}
                    </div>
                )}
                <div className="mt-1.5 text-[10px] text-slate-500 uppercase tracking-widest flex justify-between items-center pt-1.5 border-t border-white/5">
                    <span>{new Date(app.lastUpdateAt).toLocaleDateString()}</span>
                    <span className={colorClass + " bg-transparent px-0 rounded-none font-bold"}>{app.status}</span>
                </div>
            </div>
        );
    };

    return (
        <Card
            title="Pipeline Kanban"
            icon={Mail}
            iconColorClass="text-blue-400"
            action={
                <button
                    onClick={onAdd}
                    className="p-1.5 bg-blue-500/10 hover:bg-blue-500/20 text-blue-400 rounded-lg transition-colors cursor-pointer"
                    title="Add application"
                >
                    <Plus className="w-4 h-4" />
                </button>
            }
            withInnerContainer
        >
            <KanbanWidget<AppRecord>
                items={apps}
                columns={pipelineColumns}
                getStatus={(app) => app.status}
                getItemId={(app) => app.id}
                onStatusChange={onStatusChange}
                renderItem={renderItem}
                loading={loading}
                emptyText="No applications"
            />
        </Card>
    );
};
