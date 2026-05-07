import React, { useState, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { KanbanColumnDef } from "../widgets/KanbanWidget";
import { TaskItem } from "../ui/TaskItem";
import { Section } from "../Section";
import { GoalCard, LifeGoal } from "../cards/GoalCard";
import { ToDoCard } from "../cards/ToDoCard";
import { Scrollbar } from "../ui/Scrollbar";
import { useServerEvents } from "@/hooks/useServerEvents";
import { api, queryKeys } from "@/lib/api-client";

export const PlanningView: React.FC = () => {
    const queryClient = useQueryClient();
    const { data: tasksData } = useQuery({ queryKey: queryKeys.tasks, queryFn: () => api.tasks.list() });
    const { data: goalsData } = useQuery({ queryKey: queryKeys.goals, queryFn: () => api.goals.list() });

    const tasks: TaskItem[] = (tasksData?.tasks ?? []) as unknown as TaskItem[];
    const lifeGoals: LifeGoal[] = (goalsData?.goals ?? []) as unknown as LifeGoal[];
    const loading = !tasksData && !goalsData;

    const [viewMode, setViewMode] = useState<"kanban" | "calendar">("kanban");
    const [newTaskText, setNewTaskText] = useState("");
    const [isCreatingTask, setIsCreatingTask] = useState(false);
    const [isCreatingGoal, setIsCreatingGoal] = useState(false);
    const [newGoalText, setNewGoalText] = useState("");
    const [newEstimatedTime, setNewEstimatedTime] = useState("");

    const invalidateTasks = useCallback(() => queryClient.invalidateQueries({ queryKey: queryKeys.tasks }), [queryClient]);
    const invalidateGoals = useCallback(() => queryClient.invalidateQueries({ queryKey: queryKeys.goals }), [queryClient]);

    useServerEvents('Task', invalidateTasks);
    useServerEvents('Goal', invalidateGoals);

    const handleStatusChange = async (taskId: string, newStatus: string) => {
        // Optimistic update
        const prev = queryClient.getQueryData(queryKeys.tasks);
        queryClient.setQueryData(queryKeys.tasks, (old: any) => ({
            tasks: (old?.tasks ?? []).map((t: any) => t.id === taskId ? { ...t, status: newStatus } : t),
        }));
        try {
            await api.tasks.update({ id: taskId, status: newStatus as 'TODO' | 'IN_PROGRESS' | 'DONE' });
        } catch (e) {
            console.error(e);
            queryClient.setQueryData(queryKeys.tasks, prev);
            invalidateTasks();
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
            if (parent && parent.priority === "LOW") isBacklogged = true;
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
        { id: "backlog", title: "Backlog", colorClass: "bg-slate-500/20 text-slate-400", filterFn: (t) => t.status === "TODO" && (t as any)._isBacklogged === true, defaultTargetStatus: "TODO" },
        { id: "todo", title: "To Do", colorClass: "bg-emerald-500/20 text-emerald-400", filterFn: (t) => t.status === "TODO" && (t as any)._isBacklogged !== true, defaultTargetStatus: "TODO" },
        { id: "in-progress", title: "In Progress", colorClass: "bg-blue-500/20 text-blue-400", filterFn: (t) => t.status === "IN_PROGRESS" || (t.status === "TODO" && t.id != null && inProgressParentIds.has(t.id)), defaultTargetStatus: "IN_PROGRESS" },
        { id: "done", title: "Done", colorClass: "bg-green-500/20 text-green-400", filterFn: (t) => t.status === "DONE", defaultTargetStatus: "DONE" },
    ];

    const calendarEvents = tasks
        .filter(t => t.dueDate)
        .map(t => ({ id: t.id, summary: `🎯 ${t.text}`, start: { dateTime: t.dueDate! }, end: { dateTime: t.dueDate! } }));

    const handleCreateTask = async (text: string) => {
        if (!text.trim()) return;
        setIsCreatingTask(true);
        try {
            await api.tasks.create({ text, isGoal: false });
            await invalidateTasks();
            setNewTaskText("");
        } catch (e) {
            console.error("Failed to create", e);
        } finally {
            setIsCreatingTask(false);
        }
    };

    const handleCreateGoal = async (text: string, estimatedTime?: string) => {
        if (!text.trim()) return;
        setIsCreatingGoal(true);
        try {
            await api.goals.create({ text, estimatedTime });
            await invalidateGoals();
            setNewGoalText("");
            setNewEstimatedTime("");
        } catch (e) {
            console.error("Failed to create goal", e);
        } finally {
            setIsCreatingGoal(false);
        }
    };

    const handleToggleGoal = async (id: string, currentStatus: boolean) => {
        const prev = queryClient.getQueryData(queryKeys.goals);
        queryClient.setQueryData(queryKeys.goals, (old: any) => ({
            goals: (old?.goals ?? []).map((g: any) => g.id === id ? { ...g, completed: !currentStatus } : g),
        }));
        try {
            await api.goals.update({ id, completed: !currentStatus });
        } catch (error) {
            console.error(error);
            queryClient.setQueryData(queryKeys.goals, prev);
            invalidateGoals();
        }
    };

    const handleDeleteGoal = async (id: string) => {
        const prev = queryClient.getQueryData(queryKeys.goals);
        queryClient.setQueryData(queryKeys.goals, (old: any) => ({
            goals: (old?.goals ?? []).filter((g: any) => g.id !== id),
        }));
        try {
            await api.goals.delete(id);
        } catch (error) {
            console.error(error);
            queryClient.setQueryData(queryKeys.goals, prev);
            invalidateGoals();
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
                    handleReload={() => invalidateTasks()}
                />
            </Section>
        </Scrollbar>
    );
};
