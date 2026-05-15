import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth-guards";

export const runtime = "nodejs";

function userIdFromGuard(guard: { session: { user?: unknown } }): string | null {
    const user = guard.session.user as { id?: string } | undefined;
    return user?.id && user.id.length > 0 ? user.id : null;
}

/**
 * GET /api/resumes/[id] — returns the full GeneratedResume row including its
 * selections + posting input. Used by the traceability UI to show "Why these
 * bullets?".
 *
 * The profile snapshot is omitted from the response payload by default — it's
 * large and only useful for re-rendering, not display. Pass `?includeSnapshot=1`
 * if you actually need it.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const guard = await requireSession();
    if ('error' in guard) return guard.error;
    const userId = userIdFromGuard(guard);
    if (!userId) return NextResponse.json({ error: "Session missing user.id" }, { status: 401 });

    const { id } = await params;
    const includeSnapshot = new URL(req.url).searchParams.get("includeSnapshot") === "1";

    try {
        const row = await prisma.generatedResume.findFirst({ where: { id, userId } });
        if (!row) return NextResponse.json({ error: "Resume not found" }, { status: 404 });

        const safeJSON = (s: string): unknown => {
            try { return JSON.parse(s); } catch { return null; }
        };

        return NextResponse.json({
            resume: {
                id: row.id,
                userId: row.userId,
                applicationId: row.applicationId,
                createdAt: row.createdAt.toISOString(),
                templateKey: row.templateKey,
                format: row.format,
                status: row.status,
                hasArtifact: row.artifactPath !== null,
                error: row.error,
                postingInput: safeJSON(row.postingInput),
                selections: safeJSON(row.selections),
                ...(includeSnapshot ? { profileSnapshot: safeJSON(row.profileSnapshot) } : {}),
            },
        }, { status: 200 });
    } catch (e) {
        console.error(`[resumes/${id} GET] error:`, e);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
