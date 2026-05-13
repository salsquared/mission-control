import { prisma } from '@/lib/prisma';
import type { Task } from '@prisma/client';

export type TaskStatus = 'TODO' | 'IN_PROGRESS' | 'DONE';
export type TaskPriority = 'BLOCKER' | 'HIGH' | 'MEDIUM' | 'LOW';

export interface TaskUpdate {
    status?: TaskStatus;
    text?: string;
    priority?: TaskPriority | null;
    dueDate?: Date | null;
    notes?: string | null;
    position?: number;
    parentId?: string | null;
}

export interface TaskCreate {
    id?: string;
    text: string;
    status?: TaskStatus;
    priority?: TaskPriority | null;
    dueDate?: Date | null;
    notes?: string | null;
    position?: number;
    parentId?: string | null;
}

export function findAllTasks(): Promise<Task[]> {
    return prisma.task.findMany({ orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] });
}

export function findTaskById(id: string): Promise<Task | null> {
    return prisma.task.findUnique({ where: { id } });
}

export function updateTask(id: string, data: TaskUpdate): Promise<Task> {
    return prisma.task.update({ where: { id }, data });
}

export function createTask(data: TaskCreate): Promise<Task> {
    return prisma.task.create({
        data: {
            ...data,
            status: data.status ?? 'TODO',
        },
    });
}

export function deleteTask(id: string): Promise<Task> {
    return prisma.task.delete({ where: { id } });
}

// Next-position helper for inserting a new task at the end (or after a parent).
export async function nextPosition(parentId: string | null): Promise<number> {
    if (parentId) {
        const parent = await prisma.task.findUnique({ where: { id: parentId }, select: { position: true } });
        if (parent) return parent.position + 1;
    }
    const max = await prisma.task.aggregate({ _max: { position: true } });
    return (max._max.position ?? 0) + 1;
}
