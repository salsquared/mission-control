import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireLocalOrSession } from "@/lib/auth-guards";
import { parseGlobalSetting, serializeGlobalSetting } from "@/lib/repositories/settings";

export async function GET(req: Request) {
    const guard = await requireLocalOrSession(req);
    if ('error' in guard) return guard.error;

    try {
        const row = await prisma.globalSetting.findUnique({ where: { id: 'global' } });
        if (!row) {
            return NextResponse.json({ data: null });
        }
        return NextResponse.json({ data: parseGlobalSetting(row) });
    } catch (error) {
        console.error("Failed to fetch settings", error);
        return NextResponse.json({ error: "Failed to fetch settings" }, { status: 500 });
    }
}

export async function POST(req: Request) {
    const guard = await requireLocalOrSession(req);
    if ('error' in guard) return guard.error;

    try {
        const body = await req.json();
        const serialized = serializeGlobalSetting(body);

        await prisma.globalSetting.upsert({
            where: { id: 'global' },
            update: serialized,
            create: { id: 'global', ...serialized },
        });

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error("Failed to update settings", error);
        return NextResponse.json({ error: "Failed to update settings" }, { status: 500 });
    }
}
