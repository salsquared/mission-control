"use client";
import React, { useState, useCallback, useMemo } from "react";
import { Briefcase, Plus, CheckSquare, X, ArrowRightLeft, Loader2, MapPin } from "lucide-react";
import { Card } from "../../ui/Card";
import { KanbanWidget, KanbanColumnDef } from "../../widgets/KanbanWidget";
import { api } from "@/lib/api-client";
import { toastStore } from "@/lib/toast-store";

export interface AppRecord {
    id: string;
    company: string;
    role: string | null;
    location: string | null;
    status: string;
    nextSteps: string | null;
    lastUpdateAt: string;
}

// MB Phase 4. Per-track presentation. The kanban columns (status flow) are
// identical across tracks. Title + icon are FIXED across tracks ("Pipeline
// Kanban" / suitcase) — only the COLOR (and the empty-state copy) diverges, so
// flipping the track switch recolors the card instead of relabeling it.
const TRACK_PRESETS = {
    career: {
        title: "Pipeline Kanban",
        icon: Briefcase,
        iconColorClass: "text-cyan-300",
        addBtnClass: "bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-300",
        emptyText: "No applications",
    },
    side: {
        title: "Pipeline Kanban",
        icon: Briefcase,
        iconColorClass: "text-amber-400",
        addBtnClass: "bg-amber-500/10 hover:bg-amber-500/20 text-amber-400",
        emptyText: "No side applications — add a gig watchlist below or click + to track one manually",
    },
} as const;
type TrackKey = keyof typeof TRACK_PRESETS;

type AppKanbanColumnDef = KanbanColumnDef<AppRecord> & { statuses: string[] };

const pipelineColumns: AppKanbanColumnDef[] = [
    { id: "interested", title: "Interested", statuses: ["INTERESTED"], filterFn: (app) => ["INTERESTED"].includes(app.status), defaultTargetStatus: "INTERESTED", colorClass: "bg-cyan-500/20 text-cyan-400 border border-cyan-500/20" },
    { id: "applied", title: "Applied", statuses: ["APPLIED", "UPDATED"], filterFn: (app) => ["APPLIED", "UPDATED"].includes(app.status), defaultTargetStatus: "APPLIED", colorClass: "bg-blue-500/20 text-blue-400 border border-blue-500/20" },
    { id: "assessment", title: "Assessment", statuses: ["ASSESSMENT"], filterFn: (app) => ["ASSESSMENT"].includes(app.status), defaultTargetStatus: "ASSESSMENT", colorClass: "bg-purple-500/20 text-purple-400 border border-purple-500/20" },
    { id: "interviewing", title: "Interviewing", statuses: ["INTERVIEW_REQUESTED", "INTERVIEW"], filterFn: (app) => ["INTERVIEW_REQUESTED", "INTERVIEW"].includes(app.status), defaultTargetStatus: "INTERVIEW", colorClass: "bg-amber-500/20 text-amber-500 border border-amber-500/20" },
    { id: "offer", title: "Offer", statuses: ["OFFER"], filterFn: (app) => ["OFFER"].includes(app.status), defaultTargetStatus: "OFFER", colorClass: "bg-emerald-500/20 text-emerald-400 border border-emerald-500/20" },
    { id: "accepted", title: "Accepted", statuses: ["ACCEPTED"], filterFn: (app) => ["ACCEPTED"].includes(app.status), defaultTargetStatus: "ACCEPTED", colorClass: "bg-green-500/20 text-green-400 border border-green-500/20" },
    { id: "declined", title: "Declined", statuses: ["DECLINED"], filterFn: (app) => ["DECLINED"].includes(app.status), defaultTargetStatus: "DECLINED", colorClass: "bg-orange-500/20 text-orange-400 border border-orange-500/20" },
    { id: "rejected", title: "Rejected", statuses: ["REJECTED"], filterFn: (app) => ["REJECTED"].includes(app.status), defaultTargetStatus: "REJECTED", colorClass: "bg-slate-500/20 text-slate-400 border border-slate-500/20" }
];

interface ApplicationsKanbanCardProps {
    apps: AppRecord[];
    loading: boolean;
    onAdd: () => void;
    onStatusChange: (id: string, newStatus: string) => void;
    onItemClick: (id: string) => void;
    /** MB Phase 4: defaults to "career" so existing call sites keep working. */
    track?: TrackKey;
    /** Story S13.8: called after a successful bulk-move so parent can invalidate. */
    onBulkMoved?: (movedIds: string[]) => void;
}

export const ApplicationsKanbanCard: React.FC<ApplicationsKanbanCardProps> = ({
    apps,
    loading,
    onAdd,
    onStatusChange,
    onItemClick,
    track = "career",
    onBulkMoved,
}) => {
    const preset = TRACK_PRESETS[track];
    const otherTrack: TrackKey = track === "career" ? "side" : "career";

    // Story S13.8 — bulk-select mode. While `selectMode` is true:
    //   - Card clicks toggle selection (don't open the detail overlay)
    //   - A footer bar shows "N selected · Move to <other-track> · Cancel"
    //   - Drag-to-status is suppressed by passing no onStatusChange to the widget
    const [selectMode, setSelectMode] = useState(false);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [moving, setMoving] = useState(false);

    const enterSelectMode = useCallback(() => {
        setSelectMode(true);
        setSelected(new Set());
    }, []);
    const exitSelectMode = useCallback(() => {
        setSelectMode(false);
        setSelected(new Set());
    }, []);

    const toggleSelect = useCallback((id: string) => {
        setSelected(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    }, []);

    const handleBulkMove = useCallback(async () => {
        if (selected.size === 0 || moving) return;
        const ids = Array.from(selected);
        setMoving(true);
        try {
            const result = await api.applications.bulkTrack({ ids, track: otherTrack });
            if (result.ok) {
                const where = otherTrack === "side" ? "Side" : "Career";
                toastStore.push({
                    message: result.updated === 0
                        ? `No rows needed moving (already on the ${otherTrack} track).`
                        : `Moved ${result.updated} ${result.updated === 1 ? 'application' : 'applications'} to ${where}.`,
                    type: "info",
                });
                onBulkMoved?.(result.ids);
                exitSelectMode();
            } else {
                // 409 conflicts — same employer already exists in target track.
                const lines = result.conflicts.map(c => `• ${c.company}`).slice(0, 5).join('\n');
                const more = result.conflicts.length > 5 ? `\n… and ${result.conflicts.length - 5} more` : '';
                toastStore.push({
                    message: `Can't move ${result.conflicts.length} ${result.conflicts.length === 1 ? 'row' : 'rows'} — already exists in target track:\n${lines}${more}`,
                    type: "error",
                });
            }
        } catch (e) {
            toastStore.push({ message: `Bulk move failed: ${e instanceof Error ? e.message : String(e)}`, type: "error" });
        } finally {
            setMoving(false);
        }
    }, [selected, otherTrack, moving, onBulkMoved, exitSelectMode]);

    const renderItem = useCallback((app: AppRecord) => {
        const colDef = pipelineColumns.find((c) => c.statuses.includes(app.status));
        const colorClass = colDef?.colorClass || "bg-slate-500/20 text-slate-400 border-none";
        const isSelected = selected.has(app.id);

        return (
            <div
                key={app.id}
                onClick={() => {
                    if (selectMode) toggleSelect(app.id);
                    else onItemClick(app.id);
                }}
                className={`bg-black/40 border rounded-xl px-3 py-2 shadow-xl hover:bg-black/60 transition-all relative overflow-hidden group ${isSelected ? 'border-blue-400/60 ring-1 ring-blue-400/40' : 'border-white/5 hover:border-white/20'}`}
            >
                <div className={`absolute top-0 left-0 w-1 h-full ${colorClass.split(" ")[0]} opacity-50`}></div>
                {selectMode && (
                    <div className="absolute top-1.5 right-1.5">
                        <input
                            type="checkbox"
                            checked={isSelected}
                            readOnly
                            tabIndex={-1}
                            className="accent-blue-500 cursor-pointer pointer-events-none"
                        />
                    </div>
                )}
                <h5 className="font-bold text-slate-100 truncate flex items-center gap-2 leading-tight">
                    {app.company}
                </h5>
                <p className="text-sm text-slate-400 line-clamp-1 leading-snug">{app.role || "Unknown Role"}</p>
                {app.location && (
                    <p className="mt-0.5 text-xs text-slate-500 line-clamp-1 leading-snug flex items-center gap-1">
                        <MapPin className="w-3 h-3 shrink-0" />
                        <span className="truncate">{app.location}</span>
                    </p>
                )}
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
    }, [selectMode, selected, toggleSelect, onItemClick]);

    // Header right-side actions: select-mode entry + add. While in select mode
    // the add button hides (you're managing existing rows, not creating one).
    const headerAction = useMemo(() => (
        <div className="flex items-center gap-1">
            {!selectMode && apps.length > 0 && (
                <button
                    onClick={enterSelectMode}
                    className="p-1.5 bg-white/5 hover:bg-white/10 text-white/60 hover:text-white rounded-lg transition-colors cursor-pointer"
                    title="Select multiple to move tracks"
                >
                    <CheckSquare className="w-4 h-4" />
                </button>
            )}
            {!selectMode && (
                <button
                    onClick={onAdd}
                    className={`p-1.5 ${preset.addBtnClass} rounded-lg transition-colors cursor-pointer`}
                    title="Add application"
                >
                    <Plus className="w-4 h-4" />
                </button>
            )}
            {selectMode && (
                <button
                    onClick={exitSelectMode}
                    className="p-1.5 bg-white/5 hover:bg-white/10 text-white/60 hover:text-white rounded-lg transition-colors cursor-pointer"
                    title="Exit selection mode"
                >
                    <X className="w-4 h-4" />
                </button>
            )}
        </div>
    ), [selectMode, apps.length, enterSelectMode, onAdd, preset.addBtnClass, exitSelectMode]);

    return (
        <Card
            title={preset.title}
            icon={preset.icon}
            iconColorClass={preset.iconColorClass}
            action={headerAction}
            withInnerContainer
        >
            {selectMode && (
                <div className="mb-2 flex items-center justify-between rounded-md bg-blue-500/10 border border-blue-400/30 px-3 py-2 text-xs">
                    <span className="text-blue-200">
                        {selected.size === 0
                            ? "Tap cards to select them."
                            : `${selected.size} selected.`}
                    </span>
                    <button
                        type="button"
                        onClick={handleBulkMove}
                        disabled={selected.size === 0 || moving}
                        className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-blue-500/30 hover:bg-blue-500/40 border border-blue-400/30 text-blue-100 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                        {moving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ArrowRightLeft className="w-3.5 h-3.5" />}
                        Move to {TRACK_PRESETS[otherTrack].title.replace(" Pipeline", "").replace(" Kanban", "")}
                    </button>
                </div>
            )}
            <KanbanWidget<AppRecord>
                items={apps}
                columns={pipelineColumns}
                getStatus={(app) => app.status}
                getItemId={(app) => app.id}
                // Drag-to-status is suppressed during selection mode — the same
                // tap can't simultaneously toggle a checkbox AND start a drag.
                onStatusChange={selectMode ? undefined : onStatusChange}
                renderItem={renderItem}
                loading={loading}
                emptyText={preset.emptyText}
            />
        </Card>
    );
};
