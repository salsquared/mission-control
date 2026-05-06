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
}

export interface TaskCreate {
    id: string;
    text: string;
    status: TaskStatus;
    filePath: string;
    lineNumber: number;
    parentId?: string | null;
    priority?: TaskPriority | null;
    dueDate?: Date | null;
    notes?: string | null;
}

export interface ParsedTaskRow {
    id: string;
    text: string;
    status: TaskStatus;
    priority: TaskPriority | null;
    dueDate: Date | null;
    filePath: string;
    lineNumber: number;
    parentId: string | null;
    notes: string;
}

export function findAllTasks(): Promise<Task[]> {
    return prisma.task.findMany({ orderBy: [{ lineNumber: 'asc' }] });
}

export function findTaskById(id: string): Promise<Task | null> {
    return prisma.task.findUnique({ where: { id } });
}

export function updateTask(id: string, data: TaskUpdate): Promise<Task> {
    return prisma.task.update({ where: { id }, data });
}

export function createTask(data: TaskCreate): Promise<Task> {
    return prisma.task.create({ data });
}

// Replaces all tasks for a given file in one transaction: deletes tasks that
// no longer appear in the file and upserts the rest. Empty-string notes are
// normalized to null at this boundary.
export async function replaceTasksFromFile(
    filePath: string,
    tasks: ParsedTaskRow[]
): Promise<void> {
    const taskIds = tasks.map(t => t.id);
    await prisma.$transaction([
        prisma.task.deleteMany({
            where: { filePath, id: { notIn: taskIds } },
        }),
        ...tasks.map(t => prisma.task.upsert({
            where: { id: t.id },
            create: {
                id: t.id,
                text: t.text,
                status: t.status,
                priority: t.priority,
                dueDate: t.dueDate,
                filePath: t.filePath,
                lineNumber: t.lineNumber,
                parentId: t.parentId,
                notes: t.notes || null,
            },
            update: {
                text: t.text,
                status: t.status,
                priority: t.priority,
                dueDate: t.dueDate,
                lineNumber: t.lineNumber,
                parentId: t.parentId,
                notes: t.notes || null,
            },
        })),
    ]);
}
