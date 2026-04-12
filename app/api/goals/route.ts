import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function GET() {
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
    try {
        const { text } = await req.json();
        if (!text) return NextResponse.json({ error: "Missing text" }, { status: 400 });
        
        const goal = await prisma.lifeGoal.create({
            data: { text }
        });
        
        return NextResponse.json({ goal });
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}

export async function PATCH(req: Request) {
    try {
        const { id, completed } = await req.json();
        if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
        
        const goal = await prisma.lifeGoal.update({
            where: { id },
            data: { completed }
        });
        
        return NextResponse.json({ goal });
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}

export async function DELETE(req: Request) {
    try {
        const { id } = await req.json();
        if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
        
        await prisma.lifeGoal.delete({
            where: { id }
        });
        
        return NextResponse.json({ success: true });
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
