import React from "react";
import { LayoutList, Calendar as CalendarIcon, Loader2, Plus, CheckSquare } from "lucide-react";
import { cn } from "@/lib/utils";
import { KanbanWidget, KanbanColumnDef } from "../widgets/KanbanWidget";
import { CalendarWidget } from "../widgets/CalendarWidget";
import { TaskItem, TaskItemComponent } from "../ui/TaskItem";
import { Card } from "../ui/Card";

export interface ToDoCardProps {
    tasks: TaskItem[];
    loading: boolean;
    viewMode: "kanban" | "calendar";
    setViewMode: (mode: "kanban" | "calendar") => void;
    newTaskText: string;
    setNewTaskText: (val: string) => void;
    isCreatingTask: boolean;
    handleCreateTask: (text: string) => void;
    handleStatusChange: (taskId: string, newStatus: string) => void;
    calendarEvents: any[];
    kanbanColumns: KanbanColumnDef<TaskItem>[];
}

export const ToDoCard: React.FC<ToDoCardProps> = ({
    tasks,
    loading,
    viewMode,
    setViewMode,
    newTaskText,
    setNewTaskText,
    isCreatingTask,
    handleCreateTask,
    handleStatusChange,
    calendarEvents,
    kanbanColumns
}) => {
    return (
        <div className="px-6 flex flex-col h-[65vh]">
            <Card
                title="Task Board"
                icon={CheckSquare}
                iconColorClass="text-emerald-400"
                wrapperClassName="bg-black/20 rounded-2xl border border-white/5 p-5 h-full overflow-hidden"
                contentClassName="pt-2 overflow-hidden"
                action={
                    <div className="flex items-center gap-4">
                        <div className="flex items-center gap-3 w-64">
                            <input 
                                value={newTaskText}
                                onChange={(e) => setNewTaskText(e.target.value)}
                                onKeyDown={(e) => { if (e.key === 'Enter') handleCreateTask(newTaskText); }}
                                placeholder="Add a new task..."
                                className="bg-black/40 border border-white/5 rounded-lg px-3 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-emerald-500/50 w-full transition-all"
                            />
                            <button 
                                onClick={() => handleCreateTask(newTaskText)}
                                disabled={isCreatingTask || !newTaskText.trim()}
                                className="bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 px-2 py-1.5 rounded-lg text-xs font-medium transition-all disabled:opacity-50 shrink-0"
                                title="Create Task"
                            >
                                {isCreatingTask ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
                            </button>
                        </div>

                        <div className="flex bg-black/40 p-1 rounded-lg border border-white/5 w-fit">
                            <button
                                onClick={() => setViewMode("kanban")}
                                className={cn(
                                    "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all cursor-pointer",
                                    viewMode === "kanban" ? "bg-white/10 text-white shadow-sm" : "text-slate-500 hover:text-slate-300 hover:bg-white/5"
                                )}
                            >
                                <LayoutList className="w-3 h-3" />
                                Board
                            </button>
                            <button
                                onClick={() => setViewMode("calendar")}
                                className={cn(
                                    "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all cursor-pointer",
                                    viewMode === "calendar" ? "bg-white/10 text-white shadow-sm" : "text-slate-500 hover:text-slate-300 hover:bg-white/5"
                                )}
                            >
                                <CalendarIcon className="w-3 h-3" />
                                Calendar
                            </button>
                        </div>
                    </div>
                }
            >
                <div className="flex-1 overflow-hidden">
                    {viewMode === "kanban" ? (
                        <KanbanWidget
                            items={tasks}
                            columns={kanbanColumns}
                            getStatus={(t) => t.status}
                            getItemId={(t) => t.id}
                            onStatusChange={handleStatusChange}
                            loading={loading}
                            renderItem={(task) => <TaskItemComponent task={task} />}
                        />
                    ) : (
                        <div className="h-full overflow-y-auto custom-scrollbar p-6">
                            <CalendarWidget 
                                isAdding={false} 
                                setIsAdding={() => {}} 
                                injectedTasks={calendarEvents as any} 
                            />
                        </div>
                    )}
                </div>
            </Card>
        </div>
    );
};
