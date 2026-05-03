import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireSession } from '@/lib/auth-guards';
import { broadcastEvent } from '@/lib/events';

export async function GET() {
    const guard = await requireSession();
    if ('error' in guard) return guard.error;

    try {
        const goals = await prisma.lifeGoal.findMany({
            orderBy: [{ createdAt: 'asc' }]
        });
        return NextResponse.json({ goals });
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}

export async function POST(req: Request) {
    const guard = await requireSession();
    if ('error' in guard) return guard.error;

    try {
        const { text, estimatedTime } = await req.json();
        if (!text) return NextResponse.json({ error: "Missing text" }, { status: 400 });

        const goal = await prisma.lifeGoal.create({
            data: { text, estimatedTime }
        });

        broadcastEvent({ model: 'Goal', action: 'upsert', id: goal.id, timestamp: Date.now() });
        return NextResponse.json({ goal });
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}

export async function PATCH(req: Request) {
    const guard = await requireSession();
    if ('error' in guard) return guard.error;

    try {
        const { id, completed } = await req.json();
        if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

        const goal = await prisma.lifeGoal.update({
            where: { id },
            data: { completed }
        });

        broadcastEvent({ model: 'Goal', action: 'upsert', id: goal.id, timestamp: Date.now() });
        return NextResponse.json({ goal });
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}

export async function DELETE(req: Request) {
    const guard = await requireSession();
    if ('error' in guard) return guard.error;

    try {
        const { id } = await req.json();
        if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

        await prisma.lifeGoal.delete({
            where: { id }
        });

        broadcastEvent({ model: 'Goal', action: 'delete', id, timestamp: Date.now() });
        return NextResponse.json({ success: true });
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
