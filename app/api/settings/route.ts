import { NextResponse } from "next/server";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export async function GET() {
    try {
        const setting = await prisma.globalSetting.findUnique({
            where: { id: "global" }
        });

        if (!setting) {
            return NextResponse.json({ data: null });
        }

        return NextResponse.json({ data: JSON.parse(setting.data) });
    } catch (error) {
        console.error("Failed to fetch settings", error);
        return NextResponse.json({ error: "Failed to fetch settings" }, { status: 500 });
    }
}

export async function POST(req: Request) {
    try {
        const body = await req.json();

        const setting = await prisma.globalSetting.upsert({
            where: { id: "global" },
            update: { data: JSON.stringify(body) },
            create: { id: "global", data: JSON.stringify(body) }
        });

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error("Failed to update settings", error);
        return NextResponse.json({ error: "Failed to update settings" }, { status: 500 });
    }
}
