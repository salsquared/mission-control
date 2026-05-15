import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth-guards";
import { readResumeArtifact } from "@/lib/resumes/storage";

export const runtime = "nodejs";

const FORMAT_CONTENT_TYPES = {
    pdf: "application/pdf",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
} as const;

function userIdFromGuard(guard: { session: { user?: unknown } }): string | null {
    const user = guard.session.user as { id?: string } | undefined;
    return user?.id && user.id.length > 0 ? user.id : null;
}

function sanitizeFilenamePart(s: string): string {
    return s.replace(/[^a-z0-9-]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase().slice(0, 40);
}

/**
 * GET /api/resumes/[id]/download — streams the archived artifact bytes.
 * Owner-only (filtered by userId on the row, not just on the file path).
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const guard = await requireSession();
    if ('error' in guard) return guard.error;
    const userId = userIdFromGuard(guard);
    if (!userId) return NextResponse.json({ error: "Session missing user.id" }, { status: 401 });

    const { id } = await params;
    try {
        const row = await prisma.generatedResume.findFirst({
            where: { id, userId },
            select: { format: true, artifactPath: true, status: true, postingInput: true, createdAt: true },
        });
        if (!row) return NextResponse.json({ error: "Resume not found" }, { status: 404 });
        if (!row.artifactPath) return NextResponse.json({ error: "Resume has no archived artifact" }, { status: 410 });

        const bytes = await readResumeArtifact(row.artifactPath).catch(() => null);
        if (!bytes) return NextResponse.json({ error: "Artifact missing on disk" }, { status: 410 });

        const format = (row.format === "docx" ? "docx" : "pdf") as keyof typeof FORMAT_CONTENT_TYPES;
        let company = "resume";
        try {
            const parsed = JSON.parse(row.postingInput) as { company?: string | null };
            if (parsed.company) company = sanitizeFilenamePart(parsed.company);
        } catch { /* ignore */ }
        const dateSlug = row.createdAt.toISOString().slice(0, 10);
        const filename = `resume-${company || "untitled"}-${dateSlug}.${format}`;

        return new NextResponse(new Uint8Array(bytes), {
            status: 200,
            headers: {
                "Content-Type": FORMAT_CONTENT_TYPES[format],
                "Content-Length": String(bytes.length),
                "Content-Disposition": `attachment; filename="${filename}"`,
                "Cache-Control": "no-store",
            },
        });
    } catch (e) {
        console.error(`[resumes/${id}/download] error:`, e);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
