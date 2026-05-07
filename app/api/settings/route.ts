import { NextResponse } from "next/server";
import { requireLocalOrSession } from "@/lib/auth-guards";
import {
    parseGlobalSetting,
    serializeGlobalSetting,
    findGlobalSetting,
    upsertGlobalSettingWithVersion,
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
        // Optimistic concurrency: client must send the version it last saw as
        // an If-Match header. Mismatch returns 409 with the current version
        // so the client can refetch and reconcile.
        const ifMatch = req.headers.get('if-match');
        const expectedVersion = ifMatch ? parseInt(ifMatch, 10) : NaN;
        if (Number.isNaN(expectedVersion) || expectedVersion < 0) {
            return NextResponse.json(
                { error: 'If-Match header required (non-negative integer version)' },
                { status: 428 }
            );
        }

        const parsed = SettingsPostSchema.safeParse(await req.json());
        if (!parsed.success) {
            return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
        }
        const serialized = serializeGlobalSetting(parsed.data);

        const result = await upsertGlobalSettingWithVersion(serialized, expectedVersion);
        if (!result.ok) {
            return NextResponse.json(
                { error: 'Version mismatch', currentVersion: result.currentVersion },
                { status: 409 }
            );
        }

        return NextResponse.json({ success: true, version: result.newVersion });
    } catch (error) {
        console.error("Failed to update settings", error);
        return NextResponse.json({ error: "Failed to update settings" }, { status: 500 });
    }
}
