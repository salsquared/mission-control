import React from "react";
import { Target, Plus, Check, Loader2, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Card } from "../ui/Card";

export interface LifeGoal {
    id: string;
    text: string;
    completed: boolean;
}

export interface GoalCardProps {
    lifeGoals: LifeGoal[];
    newGoalText: string;
    setNewGoalText: (text: string) => void;
    isCreatingGoal: boolean;
    handleCreateGoal: (text: string) => void;
    handleToggleGoal: (id: string, currentStatus: boolean) => void;
    handleDeleteGoal: (id: string) => void;
}

export const GoalCard: React.FC<GoalCardProps> = ({
    lifeGoals,
    newGoalText,
    setNewGoalText,
    isCreatingGoal,
    handleCreateGoal,
    handleToggleGoal,
    handleDeleteGoal
}) => {
    return (
        <div className="px-6">
            <Card
                title="Tracked Milestones"
                icon={Target}
                iconColorClass="text-emerald-400"
                wrapperClassName="bg-black/40 border border-white/5 hover:border-cyan-500/30 transition-colors rounded-2xl p-5 shrink-0 max-h-[35vh] min-h-0"
                action={
                    <div className="flex items-center gap-2">
                        <input 
                            value={newGoalText}
                            onChange={(e) => setNewGoalText(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') handleCreateGoal(newGoalText); }}
                            placeholder="New life goal..."
                            className="bg-black/20 border border-white/5 rounded-lg px-3 py-1 text-xs text-slate-200 focus:outline-none focus:border-emerald-500/50 transition-all w-48"
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
                            <div key={goal.id} className="bg-slate-800/50 p-3 rounded-xl border border-slate-700/50 flex items-start gap-3 group relative">
                                <button 
                                    onClick={() => handleToggleGoal(goal.id, goal.completed)}
                                    className={cn(
                                        "mt-0.5 shrink-0 w-4 h-4 rounded border flex items-center justify-center transition-all",
                                        goal.completed ? "bg-emerald-500/20 border-emerald-500/50 text-emerald-400" : "border-slate-500 hover:border-slate-400 text-transparent"
                                    )}
                                >
                                    <Check className="w-3 h-3" />
                                </button>
                                <p className={cn("text-sm font-medium transition-all group-hover:pr-6", goal.completed ? "text-slate-500 line-through" : "text-slate-200")}>
                                    {goal.text}
                                </p>
                                <button 
                                    onClick={() => handleDeleteGoal(goal.id)}
                                    className="absolute right-2 top-2 opacity-0 group-hover:opacity-100 text-slate-500 hover:text-red-400 hover:bg-red-400/10 p-1.5 rounded transition-all"
                                >
                                    <Trash2 className="w-3 h-3" />
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
