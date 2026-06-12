import { prisma } from '@/lib/prisma';
import type { Task } from '@prisma/client';

// P2.2 (OQ2a): every query is userId-scoped — the route resolves the userId
// from the session (or the LAN owner fallback, lib/user-scope.ts) and threads
// it through. Mutations key on { id, userId } so a stranger's id-guess can
// never touch another user's row (Prisma extended where-unique).

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

export function findAllTasks(userId: string): Promise<Task[]> {
    return prisma.task.findMany({
        where: { userId },
        orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    });
}

export function findTaskById(id: string, userId: string): Promise<Task | null> {
    return prisma.task.findFirst({ where: { id, userId } });
}

export function updateTask(id: string, userId: string, data: TaskUpdate): Promise<Task> {
    return prisma.task.update({ where: { id, userId }, data });
}

export function createTask(userId: string, data: TaskCreate): Promise<Task> {
    return prisma.task.create({
        data: {
            ...data,
            userId,
            status: data.status ?? 'TODO',
        },
    });
}

export function deleteTask(id: string, userId: string): Promise<Task> {
    return prisma.task.delete({ where: { id, userId } });
}

// Next-position helper for inserting a new task at the end (or after a parent).
export async function nextPosition(parentId: string | null, userId: string): Promise<number> {
    if (parentId) {
        const parent = await prisma.task.findFirst({
            where: { id: parentId, userId },
            select: { position: true },
        });
        if (parent) return parent.position + 1;
    }
    const max = await prisma.task.aggregate({ where: { userId }, _max: { position: true } });
    return (max._max.position ?? 0) + 1;
}
