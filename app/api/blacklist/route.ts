import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/auth-guards";
import { addToBlacklist, listBlacklist } from "@/lib/repositories/blacklist";

export const runtime = "nodejs";

function userIdFromGuard(guard: { session: { user?: unknown } }): string | null {
    const user = guard.session.user as { id?: string } | undefined;
    return user?.id && user.id.length > 0 ? user.id : null;
}

const PostSchema = z.object({
    name: z.string().min(1).max(120),
    reason: z.string().max(280).optional().nullable(),
});

export async function GET() {
    const guard = await requireSession();
    if ("error" in guard) return guard.error;
    const userId = userIdFromGuard(guard);
    if (!userId) return NextResponse.json({ error: "Session missing user.id" }, { status: 401 });

    try {
        const entries = await listBlacklist(userId);
        return NextResponse.json({ entries }, { status: 200 });
    } catch (e) {
        console.error("[blacklist GET] error:", e);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}

export async function POST(req: NextRequest) {
    const guard = await requireSession();
    if ("error" in guard) return guard.error;
    const userId = userIdFromGuard(guard);
    if (!userId) return NextResponse.json({ error: "Session missing user.id" }, { status: 401 });

    const parsed = PostSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
        return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
    }

    try {
        const result = await addToBlacklist(userId, parsed.data.name, parsed.data.reason ?? null);
        if (!result.ok) {
            return NextResponse.json({ error: `Could not add (${result.reason})` }, { status: 400 });
        }
        return NextResponse.json({ entry: result.entry }, { status: 200 });
    } catch (e) {
        console.error("[blacklist POST] error:", e);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
