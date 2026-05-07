import { NextResponse } from 'next/server';
import { requireLocalOrSession } from '@/lib/auth-guards';
import { broadcastEvent } from '@/lib/events';
import { findAllGoals, createGoal, updateGoal, deleteGoal } from '@/lib/repositories/goals';
import { GoalPostSchema, GoalPatchSchema, GoalDeleteSchema } from '@/lib/schemas/goals';

export async function GET(req: Request) {
    const guard = await requireLocalOrSession(req);
    if ('error' in guard) return guard.error;

    try {
        const goals = await findAllGoals();
        return NextResponse.json({ goals });
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}

export async function POST(req: Request) {
    const guard = await requireLocalOrSession(req);
    if ('error' in guard) return guard.error;

    try {
        const parsed = GoalPostSchema.safeParse(await req.json());
        if (!parsed.success) {
            return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
        }

        const goal = await createGoal(parsed.data);

        broadcastEvent({ model: 'Goal', action: 'upsert', id: goal.id, timestamp: Date.now() });
        return NextResponse.json({ goal });
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}

export async function PATCH(req: Request) {
    const guard = await requireLocalOrSession(req);
    if ('error' in guard) return guard.error;

    try {
        const parsed = GoalPatchSchema.safeParse(await req.json());
        if (!parsed.success) {
            return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
        }
        const { id, completed } = parsed.data;

        const goal = await updateGoal(id, { completed });

        broadcastEvent({ model: 'Goal', action: 'upsert', id: goal.id, timestamp: Date.now() });
        return NextResponse.json({ goal });
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}

export async function DELETE(req: Request) {
    const guard = await requireLocalOrSession(req);
    if ('error' in guard) return guard.error;

    try {
        const parsed = GoalDeleteSchema.safeParse(await req.json());
        if (!parsed.success) {
            return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
        }
        const { id } = parsed.data;

        await deleteGoal(id);

        broadcastEvent({ model: 'Goal', action: 'delete', id, timestamp: Date.now() });
        return NextResponse.json({ success: true });
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
