import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireSession } from '@/lib/auth-guards';
import { broadcastEvent } from '@/lib/events';
import { regenerateMarkdownFromDB } from '@/lib/tasks/regenerator';
import { syncTasksFromFile } from '@/lib/tasks/parser';
import { TaskPatchSchema, TaskPostSchema } from '@/lib/schemas/tasks';
import path from 'path';

class Mutex {
    private mutex = Promise.resolve();
    lock(): Promise<() => void> {
        let begin: (unlock: () => void) => void = () => {};
        this.mutex = this.mutex.then(() => new Promise(begin));
        return new Promise(res => { begin = res; });
    }
}
const writeMutex = new Mutex();

const DEFAULT_MD_FILE = path.join(process.cwd(), 'docs', 'todo.md');

export async function GET(req: Request) {
    const guard = await requireSession();
    if ('error' in guard) return guard.error;

    try {
        const url = new URL(req.url);
        if (url.searchParams.get('force') === 'true') {
            await syncTasksFromFile(DEFAULT_MD_FILE);
        }

        const tasks = await prisma.task.findMany({
            orderBy: [{ lineNumber: 'asc' }]
        });

        return NextResponse.json({ tasks });
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}

export async function PATCH(req: Request) {
    const guard = await requireSession();
    if ('error' in guard) return guard.error;

    const unlock = await writeMutex.lock();
    try {
        const parsed = TaskPatchSchema.safeParse(await req.json());
        if (!parsed.success) {
            return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
        }
        const { id, status, text, dueDate, priority } = parsed.data;

        const task = await prisma.task.findUnique({ where: { id } });
        if (!task) {
            return NextResponse.json({ error: 'Task not found' }, { status: 404 });
        }

        const updateData: any = {};
        if (status !== undefined) updateData.status = status;
        if (text !== undefined) updateData.text = text;
        if (dueDate !== undefined) updateData.dueDate = dueDate ? new Date(dueDate) : null;
        if (priority !== undefined) updateData.priority = priority;

        const updatedTask = await prisma.task.update({ where: { id }, data: updateData });

        broadcastEvent({ model: 'Task', action: 'upsert', id, timestamp: Date.now() });

        regenerateMarkdownFromDB().catch(console.error);

        return NextResponse.json({ task: updatedTask });
    } catch (e: any) {
        console.error('PATCH error:', e);
        return NextResponse.json({ error: e.message }, { status: 500 });
    } finally {
        unlock();
    }
}

export async function POST(req: Request) {
    const guard = await requireSession();
    if ('error' in guard) return guard.error;

    const unlock = await writeMutex.lock();
    try {
        const parsed = TaskPostSchema.safeParse(await req.json());
        if (!parsed.success) {
            return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
        }
        const { text, parentId, isGoal } = parsed.data;

        const newId = crypto.randomUUID();
        const parentTask = parentId ? await prisma.task.findUnique({ where: { id: parentId } }) : null;
        const lineNumber = parentTask ? parentTask.lineNumber + 1 : 999999;

        await prisma.task.create({
            data: {
                id: newId,
                text,
                status: 'TODO',
                filePath: DEFAULT_MD_FILE,
                lineNumber,
                parentId: parentTask?.id ?? null,
            }
        });

        if (isGoal) {
            await prisma.task.create({
                data: {
                    id: crypto.randomUUID(),
                    text: 'Define action items for this goal',
                    status: 'TODO',
                    filePath: DEFAULT_MD_FILE,
                    lineNumber: lineNumber + 1,
                    parentId: newId,
                }
            });
        }

        broadcastEvent({ model: 'Task', action: 'upsert', id: newId, timestamp: Date.now() });

        regenerateMarkdownFromDB().catch(console.error);

        return NextResponse.json({ success: true, id: newId });
    } catch (e: any) {
        console.error('POST error:', e);
        return NextResponse.json({ error: e.message }, { status: 500 });
    } finally {
        unlock();
    }
}
