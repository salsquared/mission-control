import React from "react";
import { Target, Plus, Check, Loader2, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Card } from "../ui/Card";

export interface LifeGoal {
    id: string;
    text: string;
    completed: boolean;
    estimatedTime?: string;
}

export interface GoalCardProps {
    lifeGoals: LifeGoal[];
    loading?: boolean;
    newGoalText: string;
    setNewGoalText: (text: string) => void;
    newEstimatedTime: string;
    setNewEstimatedTime: (time: string) => void;
    isCreatingGoal: boolean;
    handleCreateGoal: (text: string) => void;
    handleToggleGoal: (id: string, currentStatus: boolean) => void;
    handleDeleteGoal: (id: string) => void;
}

export const GoalCard: React.FC<GoalCardProps> = ({
    lifeGoals,
    loading,
    newGoalText,
    setNewGoalText,
    newEstimatedTime,
    setNewEstimatedTime,
    isCreatingGoal,
    handleCreateGoal,
    handleToggleGoal,
    handleDeleteGoal
}) => {
    return (
        <div className="px-2">
            <Card
                title="Tracked Milestones"
                icon={Target}
                iconColorClass="text-emerald-400"
                wrapperClassName="bg-black/40 border border-white/5 hover:border-cyan-500/30 transition-colors rounded-2xl p-5 shrink-0 max-h-[35vh] min-h-0"
                loading={loading}
                action={
                    <div className="flex items-center gap-2">
                        <input 
                            value={newGoalText}
                            onChange={(e) => setNewGoalText(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') handleCreateGoal(newGoalText); }}
                            placeholder="New life goal..."
                            className="bg-black/20 border border-white/5 rounded-lg px-3 py-1 text-xs text-slate-200 focus:outline-none focus:border-emerald-500/50 transition-all w-48"
                        />
                        <input 
                            value={newEstimatedTime}
                            onChange={(e) => setNewEstimatedTime(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') handleCreateGoal(newGoalText); }}
                            placeholder="Est. time (e.g. 2 yrs)"
                            className="bg-black/20 border border-white/5 rounded-lg px-3 py-1 text-xs text-slate-200 focus:outline-none focus:border-emerald-500/50 transition-all w-36"
                        />
                        <button 
                            onClick={() => handleCreateGoal(newGoalText)}
                            disabled={isCreatingGoal || !newGoalText.trim()}
                            className="text-emerald-400 hover:bg-emerald-500/20 p-1 rounded transition-all disabled:opacity-50 shrink-0"
                        >
                            {isCreatingGoal ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
                        </button>
                    </div>
                }
            >
                {lifeGoals.length > 0 ? (
                    <div className="overflow-y-auto custom-scrollbar pr-2 grid grid-cols-2 lg:grid-cols-3 gap-3">
                        {lifeGoals.map(goal => (
                            <div key={goal.id} className="bg-slate-800/50 py-2.5 px-3 rounded-xl border border-slate-700/50 flex items-center gap-3 group">
                                <button 
                                    onClick={() => handleToggleGoal(goal.id, goal.completed)}
                                    className={cn(
                                        "shrink-0 w-4 h-4 rounded border flex items-center justify-center transition-all",
                                        goal.completed ? "bg-emerald-500/20 border-emerald-500/50 text-emerald-400" : "border-slate-500 hover:border-slate-400 text-transparent"
                                    )}
                                >
                                    <Check className="w-3 h-3" />
                                </button>
                                <div className="flex-1 min-w-0 flex flex-col justify-center">
                                    <p className={cn("text-sm font-medium transition-all break-words", goal.completed ? "text-slate-500 line-through" : "text-slate-200")}>
                                        {goal.text}
                                    </p>
                                    {goal.estimatedTime && (
                                        <span className={cn("text-xs border rounded inline-block px-1.5 py-0.5 mt-1 w-fit transition-all", goal.completed ? "text-slate-600 border-slate-700/50" : "text-slate-400 border-slate-700")}>
                                            {goal.estimatedTime}
                                        </span>
                                    )}
                                </div>
                                <button 
                                    onClick={() => handleDeleteGoal(goal.id)}
                                    className="opacity-0 group-hover:opacity-100 shrink-0 text-slate-500 hover:text-red-400 hover:bg-red-400/10 p-1.5 rounded transition-all"
                                >
                                    <Trash2 className="w-3.5 h-3.5" />
                                </button>
                            </div>
                        ))}
                    </div>
                ) : (
                    <div className="flex flex-col items-center justify-center py-6 border border-white/5 rounded-2xl border-dashed opacity-50">
                        <h3 className="text-sm font-medium text-slate-300">No Life Goals Tracked</h3>
                    </div>
                )}
            </Card>
        </div>
    );
};
