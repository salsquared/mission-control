import React, { useState, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { Clock, Loader2, Edit2, Check } from "lucide-react";

export interface TaskItem {
    id: string;
    text: string;
    status: string;
    priority: string | null;
    dueDate: string | null;
    parentId: string | null;
    indentLevel?: number;
    notes?: string | null;
    _childrenCount?: number;
    _childrenDoneCount?: number;
    _depth?: number;
}

const PRIORITY_COLORS: Record<string, { bg: string, text: string, label: string }> = {
    BLOCKER: { bg: "bg-red-500/10 border-red-500/20", text: "text-red-500", label: "🔴 Blocker" },
    HIGH: { bg: "bg-yellow-500/10 border-yellow-500/20", text: "text-yellow-500", label: "🟡 High" },
    MEDIUM: { bg: "bg-blue-500/10 border-blue-500/20", text: "text-blue-500", label: "🔵 Medium" },
    LOW: { bg: "bg-green-500/10 border-green-500/20", text: "text-green-500", label: "🟢 Low" }
};

export const TaskItemComponent: React.FC<{ task: TaskItem }> = ({ task }) => {
    const [isEditing, setIsEditing] = useState(false);
    const [editValue, setEditValue] = useState(task.text);
    const [isSaving, setIsSaving] = useState(false);
    const [localText, setLocalText] = useState(task.text);
    const [localDueDate, setLocalDueDate] = useState<string | null>(task.dueDate);
    const [localPriority, setLocalPriority] = useState<string | null>(task.priority);
    const [showPrioMenu, setShowPrioMenu] = useState(false);
    const prioRef = useRef<HTMLDivElement>(null);

    // Sync local state if task prop changes externally
    useEffect(() => {
        setLocalText(task.text);
        setEditValue(task.text);
        setLocalDueDate(task.dueDate);
        setLocalPriority(task.priority);
    }, [task.text, task.dueDate, task.priority]);

    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            if (prioRef.current && !prioRef.current.contains(e.target as Node)) {
                setShowPrioMenu(false);
            }
        };
        if (showPrioMenu) document.addEventListener("mousedown", handleClickOutside);
        return () => document.removeEventListener("mousedown", handleClickOutside);
    }, [showPrioMenu]);

    const prio = localPriority ? PRIORITY_COLORS[localPriority] : null;
    const hasParent = !!task.parentId;
    const depth = task._depth || (hasParent ? 1 : 0);

    const handleSave = async () => {
        if (!editValue.trim() || editValue === localText) {
            setEditValue(localText);
            setIsEditing(false);
            return;
        }
        setIsSaving(true);
        try {
            const res = await fetch('/api/tasks', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: task.id, text: editValue.trim() })
            });
            if (res.ok) {
                setLocalText(editValue.trim());
                setIsEditing(false);
            } else {
                console.error("Failed to save task text");
            }
        } catch (e) {
            console.error(e);
        } finally {
            setIsSaving(false);
        }
    };

    const handleSetDate = async (newDate: string) => {
        setLocalDueDate(newDate);
        try {
            await fetch('/api/tasks', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: task.id, dueDate: newDate })
            });
        } catch (e) {
            console.error("Failed to set due date:", e);
        }
    };

    const handleSetPriority = async (newPrio: string | null) => {
        setShowPrioMenu(false);
        setLocalPriority(newPrio);
        try {
            await fetch('/api/tasks', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: task.id, priority: newPrio })
            });
        } catch (e) {
            console.error("Failed to set priority:", e);
        }
    };

    return (
        <div 
            style={{ marginLeft: `${depth * 1}rem` }}
            className={cn(
            "bg-slate-800/80 hover:bg-slate-800 border-l-[3px] border-y border-r border-slate-700/50 hover:border-slate-600 rounded-xl px-2 py-1 transition-all group flex flex-col gap-1 relative shadow-md overflow-visible",
            prio ? (
                localPriority === 'BLOCKER' ? 'border-l-red-500' :
                    localPriority === 'HIGH' ? 'border-l-yellow-500' :
                        localPriority === 'MEDIUM' ? 'border-l-blue-500' :
                            'border-l-green-500'
            ) : 'border-l-slate-600',
            hasParent ? 'bg-slate-800/40' : ''
        )}>
            <div className="flex items-center w-full gap-2 min-h-[20px]">
                <div className="flex items-center gap-2 min-w-0 flex-1">
                    <div className="relative shrink-0 flex items-center" ref={prioRef}>
                        {prio ? (
                            <button
                                onClick={() => setShowPrioMenu(!showPrioMenu)}
                                className={cn("flex items-center text-[9px] font-bold uppercase px-1.5 py-0.5 rounded border leading-none cursor-pointer transition-colors hover:opacity-80", prio.bg, prio.text)}
                            >
                                {prio.label}
                            </button>
                        ) : (
                            <button
                                onClick={() => setShowPrioMenu(!showPrioMenu)}
                                className="opacity-0 group-hover:opacity-100 transition-opacity flex items-center text-[9px] text-slate-500 hover:text-slate-300 font-bold bg-white/5 hover:bg-white/10 px-1.5 py-0.5 rounded border border-white/5 uppercase leading-none"
                            >
                                Set Prio
                            </button>
                        )}

                        {showPrioMenu && (
                            <div className="absolute top-full left-0 mt-1 bg-slate-800 border border-slate-700 rounded shadow-xl z-50 py-1 min-w-[100px] flex flex-col overflow-hidden">
                                {Object.entries(PRIORITY_COLORS).map(([k, v]) => (
                                    <button
                                        key={k}
                                        onClick={() => handleSetPriority(k)}
                                        className={cn("text-[10px] font-bold uppercase px-3 py-1.5 text-left hover:bg-slate-700/50 transition-colors", v.text)}
                                    >
                                        {v.label}
                                    </button>
                                ))}
                                <button
                                    onClick={() => handleSetPriority(null)}
                                    className="text-[10px] font-bold uppercase px-3 py-1.5 text-left text-slate-400 hover:text-slate-300 hover:bg-slate-700/50 transition-colors"
                                >
                                    None
                                </button>
                            </div>
                        )}
                    </div>

                    {localDueDate ? (
                        <div className="relative group/date cursor-pointer flex items-center gap-1 text-[9px] font-bold uppercase text-slate-400 hover:text-slate-300 transition-colors bg-white/5 hover:bg-white/10 px-1.5 py-0.5 rounded border border-white/5 leading-none min-w-0 z-10">
                            <Clock className="w-2.5 h-2.5 shrink-0" />
                            <span className="truncate whitespace-nowrap">Due {new Date(localDueDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                            <input
                                type="date"
                                className="absolute inset-0 opacity-0 cursor-pointer w-full h-full"
                                onChange={(e) => e.target.value && handleSetDate(e.target.value)}
                            />
                        </div>
                    ) : (
                        <div className="relative flex items-center justify-start opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                            <button className="flex items-center gap-1 text-[9px] font-bold uppercase text-slate-500 hover:text-slate-300 transition-colors bg-white/5 hover:bg-white/10 px-1.5 py-0.5 rounded border border-white/5 leading-none">
                                <Clock className="w-2.5 h-2.5" />
                                <span>Set Date</span>
                            </button>
                            <input
                                type="date"
                                className="absolute inset-0 opacity-0 cursor-pointer w-full h-full"
                                onChange={(e) => e.target.value && handleSetDate(e.target.value)}
                            />
                        </div>
                    )}
                </div>

                <div className="shrink-0 flex items-center justify-end gap-2">
                    {(task._childrenCount ?? 0) > 0 && (
                        <div className="text-[10px] font-mono text-slate-400 opacity-60 group-hover:opacity-100 transition-opacity">
                            {task._childrenDoneCount}/{task._childrenCount} subtasks
                        </div>
                    )}
                    {isEditing ? (
                        <button
                            onClick={handleSave}
                            disabled={isSaving}
                            className="flex items-center gap-1 text-[9px] font-bold uppercase text-emerald-400 hover:text-emerald-300 bg-emerald-400/10 hover:bg-emerald-400/20 px-1.5 py-0.5 rounded border border-emerald-400/20 leading-none transition-colors"
                        >
                            {isSaving ? <Loader2 className="w-2.5 h-2.5 animate-spin shrink-0" /> : <Check className="w-2.5 h-2.5 shrink-0" />}
                            <span>{isSaving ? 'Saving' : 'Save'}</span>
                        </button>
                    ) : (
                        <button
                            onClick={() => setIsEditing(true)}
                            className="opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1 text-[9px] font-bold uppercase text-slate-500 hover:text-slate-300 bg-white/5 hover:bg-white/10 px-1.5 py-0.5 rounded border border-white/5 leading-none"
                            title="Edit task"
                        >
                            <Edit2 className="w-2.5 h-2.5 shrink-0" />
                            <span>Edit</span>
                        </button>
                    )}
                </div>
            </div>

            {isEditing ? (
                <textarea
                    value={editValue}
                    onChange={e => setEditValue(e.target.value)}
                    onKeyDown={e => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            handleSave();
                        } else if (e.key === 'Escape') {
                            setEditValue(localText);
                            setIsEditing(false);
                        }
                    }}
                    autoFocus
                    className="w-full bg-black/40 border border-white/10 rounded p-2 text-[14px] text-slate-200 focus:outline-none focus:border-emerald-500/50 transition-colors resize-none overflow-hidden"
                    rows={Math.max(1, editValue.split('\n').length)}
                />
            ) : (
                <p className="text-[14px] text-slate-200 leading-relaxed font-medium">
                    {localText}
                </p>
            )}

            {task.notes && (
                <div className="mt-1 bg-black/20 rounded p-2.5 text-[11px] text-slate-400 font-mono whitespace-pre-wrap max-h-24 overflow-y-auto custom-scrollbar border border-white/5 relative z-10 cursor-text">
                    {task.notes}
                </div>
            )}
        </div>
    );
};
