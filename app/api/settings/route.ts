import { NextResponse } from "next/server";
import { requireLocalOrSession } from "@/lib/auth-guards";
import {
    parseGlobalSetting,
    serializeGlobalSetting,
    findGlobalSetting,
    upsertGlobalSetting,
} from "@/lib/repositories/settings";
import { SettingsPostSchema } from "@/lib/schemas/settings";

export async function GET(req: Request) {
    const guard = await requireLocalOrSession(req);
    if ('error' in guard) return guard.error;

    try {
        const row = await findGlobalSetting();
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
        const parsed = SettingsPostSchema.safeParse(await req.json());
        if (!parsed.success) {
            return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
        }
        const serialized = serializeGlobalSetting(parsed.data);

        await upsertGlobalSetting(serialized);

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error("Failed to update settings", error);
        return NextResponse.json({ error: "Failed to update settings" }, { status: 500 });
    }
}
