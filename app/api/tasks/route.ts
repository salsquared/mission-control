import { NextResponse } from 'next/server';
import { requireLocalOrSession } from '@/lib/auth-guards';
import { resolveScopedUserId } from '@/lib/user-scope';
import { broadcastEvent } from '@/lib/events';
import { TaskPatchSchema, TaskPostSchema, TaskDeleteSchema } from '@/lib/schemas/tasks';
import { isRestartFlagSet } from '@/lib/restart-guard';
import {
    findAllTasks,
    findTaskById,
    updateTask,
    createTask,
    deleteTask,
    nextPosition,
    type TaskUpdate,
} from '@/lib/repositories/tasks';

// P2.2 (OQ2a): every handler scopes to the session user (or the LAN owner
// fallback — see lib/user-scope.ts), so an authenticated stranger only ever
// sees / touches their own (empty) task set.
const NO_USER = () =>
    NextResponse.json({ error: 'No user account resolvable for this request' }, { status: 401 });

export async function GET(req: Request) {
    const guard = await requireLocalOrSession(req);
    if ('error' in guard) return guard.error;
    const userId = await resolveScopedUserId(guard);
    if (!userId) return NO_USER();

    try {
        const tasks = await findAllTasks(userId);
        return NextResponse.json({ tasks });
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}

export async function PATCH(req: Request) {
    if (isRestartFlagSet()) {
        return NextResponse.json({ error: 'Server is restarting, please retry in a moment.' }, { status: 503 });
    }
    const guard = await requireLocalOrSession(req);
    if ('error' in guard) return guard.error;
    const userId = await resolveScopedUserId(guard);
    if (!userId) return NO_USER();

    try {
        const parsed = TaskPatchSchema.safeParse(await req.json());
        if (!parsed.success) {
            return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
        }
        const { id, status, text, dueDate, priority, position, parentId } = parsed.data;

        const task = await findTaskById(id, userId);
        if (!task) {
            return NextResponse.json({ error: 'Task not found' }, { status: 404 });
        }

        const updateData: TaskUpdate = {};
        if (status !== undefined) updateData.status = status;
        if (text !== undefined) updateData.text = text;
        if (dueDate !== undefined) updateData.dueDate = dueDate ? new Date(dueDate) : null;
        if (priority !== undefined) updateData.priority = priority;
        if (position !== undefined) updateData.position = position;
        if (parentId !== undefined) updateData.parentId = parentId;

        const updatedTask = await updateTask(id, userId, updateData);

        broadcastEvent({ model: 'Task', action: 'upsert', id, timestamp: Date.now() });

        return NextResponse.json({ task: updatedTask });
    } catch (e: any) {
        console.error('PATCH error:', e);
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}

export async function POST(req: Request) {
    if (isRestartFlagSet()) {
        return NextResponse.json({ error: 'Server is restarting, please retry in a moment.' }, { status: 503 });
    }
    const guard = await requireLocalOrSession(req);
    if ('error' in guard) return guard.error;
    const userId = await resolveScopedUserId(guard);
    if (!userId) return NO_USER();

    try {
        const parsed = TaskPostSchema.safeParse(await req.json());
        if (!parsed.success) {
            return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
        }
        const { text, parentId, isGoal } = parsed.data;

        const parentTask = parentId ? await findTaskById(parentId, userId) : null;
        const position = await nextPosition(parentTask?.id ?? null, userId);

        const created = await createTask(userId, {
            text,
            status: 'TODO',
            position,
            parentId: parentTask?.id ?? null,
        });

        if (isGoal) {
            await createTask(userId, {
                text: 'Define action items for this goal',
                status: 'TODO',
                position: position + 1,
                parentId: created.id,
            });
        }

        broadcastEvent({ model: 'Task', action: 'upsert', id: created.id, timestamp: Date.now() });

        return NextResponse.json({ success: true, id: created.id });
    } catch (e: any) {
        console.error('POST error:', e);
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}

export async function DELETE(req: Request) {
    if (isRestartFlagSet()) {
        return NextResponse.json({ error: 'Server is restarting, please retry in a moment.' }, { status: 503 });
    }
    const guard = await requireLocalOrSession(req);
    if ('error' in guard) return guard.error;
    const userId = await resolveScopedUserId(guard);
    if (!userId) return NO_USER();

    try {
        const url = new URL(req.url);
        const idParam = url.searchParams.get('id');
        const body = idParam ? { id: idParam } : await req.json().catch(() => ({}));
        const parsed = TaskDeleteSchema.safeParse(body);
        if (!parsed.success) {
            return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
        }
        const { id } = parsed.data;

        const existing = await findTaskById(id, userId);
        if (!existing) {
            return NextResponse.json({ error: 'Task not found' }, { status: 404 });
        }

        await deleteTask(id, userId);
        broadcastEvent({ model: 'Task', action: 'delete', id, timestamp: Date.now() });

        return NextResponse.json({ success: true, id });
    } catch (e: any) {
        console.error('DELETE error:', e);
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
