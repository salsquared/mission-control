import { NextResponse } from 'next/server';
import { requireLocalOrSession } from '@/lib/auth-guards';
import { resolveScopedUserId } from '@/lib/user-scope';
import { broadcastEvent } from '@/lib/events';
import { findAllGoals, createGoal, updateGoal, deleteGoal } from '@/lib/repositories/goals';
import { GoalPostSchema, GoalPatchSchema, GoalDeleteSchema } from '@/lib/schemas/goals';

// P2.2 (OQ2a): every handler scopes to the session user (or the LAN owner
// fallback — see lib/user-scope.ts).
const NO_USER = () =>
    NextResponse.json({ error: 'No user account resolvable for this request' }, { status: 401 });

export async function GET(req: Request) {
    const guard = await requireLocalOrSession(req);
    if ('error' in guard) return guard.error;
    const userId = await resolveScopedUserId(guard);
    if (!userId) return NO_USER();

    try {
        const goals = await findAllGoals(userId);
        return NextResponse.json({ goals });
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}

export async function POST(req: Request) {
    const guard = await requireLocalOrSession(req);
    if ('error' in guard) return guard.error;
    const userId = await resolveScopedUserId(guard);
    if (!userId) return NO_USER();

    try {
        const parsed = GoalPostSchema.safeParse(await req.json());
        if (!parsed.success) {
            return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
        }

        const goal = await createGoal(userId, parsed.data);

        broadcastEvent({ model: 'Goal', action: 'upsert', id: goal.id, timestamp: Date.now() });
        return NextResponse.json({ goal });
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}

export async function PATCH(req: Request) {
    const guard = await requireLocalOrSession(req);
    if ('error' in guard) return guard.error;
    const userId = await resolveScopedUserId(guard);
    if (!userId) return NO_USER();

    try {
        const parsed = GoalPatchSchema.safeParse(await req.json());
        if (!parsed.success) {
            return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
        }
        const { id, completed } = parsed.data;

        const goal = await updateGoal(id, userId, { completed });

        broadcastEvent({ model: 'Goal', action: 'upsert', id: goal.id, timestamp: Date.now() });
        return NextResponse.json({ goal });
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}

export async function DELETE(req: Request) {
    const guard = await requireLocalOrSession(req);
    if ('error' in guard) return guard.error;
    const userId = await resolveScopedUserId(guard);
    if (!userId) return NO_USER();

    try {
        const parsed = GoalDeleteSchema.safeParse(await req.json());
        if (!parsed.success) {
            return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
        }
        const { id } = parsed.data;

        await deleteGoal(id, userId);

        broadcastEvent({ model: 'Goal', action: 'delete', id, timestamp: Date.now() });
        return NextResponse.json({ success: true });
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
