import React, { useState, useEffect } from "react";
import { KanbanColumnDef } from "../widgets/KanbanWidget";
import { TaskItem } from "../ui/TaskItem";
import { Section } from "../Section";
import { GoalCard, LifeGoal } from "../cards/GoalCard";
import { ToDoCard } from "../cards/ToDoCard";
import { Scrollbar } from "../ui/Scrollbar";



export const PlanningView: React.FC = () => {
    const [tasks, setTasks] = useState<TaskItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [viewMode, setViewMode] = useState<"kanban" | "calendar">("kanban");
    const [newTaskText, setNewTaskText] = useState("");
    const [isCreatingTask, setIsCreatingTask] = useState(false);
    
    // Goals explicit state
    const [lifeGoals, setLifeGoals] = useState<LifeGoal[]>([]);
    const [isCreatingGoal, setIsCreatingGoal] = useState(false);
    const [newGoalText, setNewGoalText] = useState("");
    const [newEstimatedTime, setNewEstimatedTime] = useState("");

    const fetchTasks = async (force = false) => {
        try {
            setLoading(true);
            const [tasksRes, goalsRes] = await Promise.all([
                fetch(`/api/tasks${force ? '?force=true' : ''}`),
                fetch("/api/goals")
            ]);
            
            const tasksData = await tasksRes.json();
            if (tasksData.tasks) {
                setTasks(tasksData.tasks);
            }

            const goalsData = await goalsRes.json();
            if (goalsData.goals) {
                setLifeGoals(goalsData.goals);
            }
        } catch (e) {
            console.error(e);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchTasks();
    }, []);

    const handleStatusChange = async (taskId: string, newStatus: string) => {
        const oldTasks = [...tasks];
        
        // Optimistic UI update
        // Note: Dragging to Backlog currently just sets to TODO. To fully support "Backlog",
        // we'd also need the API to update priority to "LOW". For now this handles basic status shifts.
        setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status: newStatus } : t));
        
        try {
            const res = await fetch("/api/tasks", {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ id: taskId, status: newStatus })
            });

            if (!res.ok) {
                throw new Error("Failed to sync status");
            }
        } catch (e) {
            console.error(e);
            setTasks(oldTasks); // revert
        }
    };

    const augmentedTasks = tasks.map(t => {
        const children = tasks.filter(child => child.parentId === t.id);
        
        let depth = 0;
        let currentParent = t.parentId;
        let isBacklogged = t.priority === "LOW";

        while (currentParent) {
            depth++;
            const parent = tasks.find(p => p.id === currentParent);
            if (parent && parent.priority === "LOW") {
                isBacklogged = true;
            }
            currentParent = parent ? parent.parentId : null;
        }

        return {
            ...t,
            _childrenCount: children.length,
            _childrenDoneCount: children.filter(c => c.status === "DONE").length,
            _depth: depth,
            _isBacklogged: isBacklogged
        };
    });

    const inProgressParentIds = new Set(
        augmentedTasks.filter(t => t.status === "IN_PROGRESS").map(t => t.parentId).filter(Boolean)
    );

    const KANBAN_COLUMNS: KanbanColumnDef<TaskItem>[] = [
        { 
            id: "backlog", 
            title: "Backlog", 
            colorClass: "bg-slate-500/20 text-slate-400",
            filterFn: (t) => t.status === "TODO" && (t as any)._isBacklogged === true,
            defaultTargetStatus: "TODO"
        },
        { 
            id: "todo", 
            title: "To Do", 
            colorClass: "bg-emerald-500/20 text-emerald-400",
            filterFn: (t) => t.status === "TODO" && (t as any)._isBacklogged !== true,
            defaultTargetStatus: "TODO"
        },
        { 
            id: "in-progress", 
            title: "In Progress", 
            colorClass: "bg-blue-500/20 text-blue-400",
            filterFn: (t) => t.status === "IN_PROGRESS" || (t.status === "TODO" && t.id != null && inProgressParentIds.has(t.id)),
            defaultTargetStatus: "IN_PROGRESS"
        },
        { 
            id: "done", 
            title: "Done", 
            colorClass: "bg-green-500/20 text-green-400",
            filterFn: (t) => t.status === "DONE",
            defaultTargetStatus: "DONE"
        },
    ];

    const calendarEvents = tasks
        .filter(t => t.dueDate)
        .map(t => ({
            id: t.id,
            summary: `🎯 ${t.text}`, 
            start: { dateTime: t.dueDate! },
            end: { dateTime: t.dueDate! }
        }));

    const handleCreateTask = async (text: string) => {
        if (!text.trim()) return;
        try {
            setIsCreatingTask(true);
            
            const res = await fetch('/api/tasks', {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ text, isGoal: false })
            });
            if (!res.ok) throw new Error("Server returned " + res.status);
            await fetchTasks();
            setNewTaskText("");
        } catch (e) {
            console.error("Failed to create", e);
        } finally {
            setIsCreatingTask(false);
        }
    };

    const handleCreateGoal = async (text: string, estimatedTime?: string) => {
        if (!text.trim()) return;
        try {
            setIsCreatingGoal(true);
            const res = await fetch('/api/goals', {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ text, estimatedTime })
            });
            if (!res.ok) throw new Error("Server returned " + res.status);
            await fetchTasks();
            setNewGoalText("");
            setNewEstimatedTime("");
        } catch (e) {
            console.error("Failed to create goal", e);
        } finally {
            setIsCreatingGoal(false);
        }
    };
    
    const handleToggleGoal = async (id: string, currentStatus: boolean) => {
        // Optimistic
        setLifeGoals(prev => prev.map(g => g.id === id ? { ...g, completed: !currentStatus } : g));
        try {
            await fetch('/api/goals', {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ id, completed: !currentStatus })
            });
        } catch (error) {
            console.error(error);
            // Revert
            setLifeGoals(prev => prev.map(g => g.id === id ? { ...g, completed: currentStatus } : g));
        }
    };
    
    const handleDeleteGoal = async (id: string) => {
        setLifeGoals(prev => prev.filter(g => g.id !== id));
        try {
            await fetch('/api/goals', {
                method: "DELETE",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ id })
            });
        } catch (error) {
            console.error(error);
            fetchTasks(); // Reload full list to revert
        }
    };

    return (
        <Scrollbar className="flex flex-col h-full w-full pb-6 pt-6 gap-2">
            <Section title="Goals">
                <GoalCard 
                    lifeGoals={lifeGoals}
                    newGoalText={newGoalText}
                    setNewGoalText={setNewGoalText}
                    newEstimatedTime={newEstimatedTime}
                    setNewEstimatedTime={setNewEstimatedTime}
                    isCreatingGoal={isCreatingGoal}
                    handleCreateGoal={(text) => handleCreateGoal(text, newEstimatedTime)}
                    handleToggleGoal={handleToggleGoal}
                    handleDeleteGoal={handleDeleteGoal}
                    loading={loading}
                />
            </Section>

            <Section title="To-Do">
                <ToDoCard 
                    tasks={augmentedTasks}
                    loading={loading}
                    viewMode={viewMode}
                    setViewMode={setViewMode}
                    newTaskText={newTaskText}
                    setNewTaskText={setNewTaskText}
                    isCreatingTask={isCreatingTask}
                    handleCreateTask={handleCreateTask}
                    handleStatusChange={handleStatusChange}
                    calendarEvents={calendarEvents}
                    kanbanColumns={KANBAN_COLUMNS}
                    handleReload={() => fetchTasks(true)}
                />
            </Section>
        </Scrollbar>
    );
};
