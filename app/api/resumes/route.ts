import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth-guards";
import { findOrCreateProfile } from "@/lib/repositories/profile";
import { parsePosting } from "@/lib/resumes/posting";
import { selectBullets, flattenSelections } from "@/lib/resumes/select";
import { rewriteBullets } from "@/lib/resumes/rewrite";
import { computeSkillsGap } from "@/lib/resumes/skills-gap";
import { composeResumeProps } from "@/lib/resumes/templates/ats-plain";
import { renderResumePDF } from "@/lib/resumes/render-pdf";
import { renderResumeDOCX } from "@/lib/resumes/render-docx";
import { writeResumeArtifact, deleteResumeArtifact } from "@/lib/resumes/storage";
import { AIError } from "@/lib/ai/gemini";
import type { ProfileWire } from "@/lib/schemas/profile";

export const runtime = "nodejs";
// PDF render is far heavier than the typical 10s API timeout.
export const maxDuration = 60;

const PostingInputSchema = z.object({
    url: z.string().url().optional(),
    text: z.string().optional(),
}).refine(p => (p.url && p.url.trim().length > 0) || (p.text && p.text.trim().length > 0), {
    message: "Provide either a url or pasted text",
});

const ResumePostBodySchema = z.object({
    posting: PostingInputSchema,
    applicationId: z.string().optional(), // attaches the GeneratedResume to an Application (M8-2.4)
    options: z.object({
        template: z.literal("ats-plain").optional(),
        format: z.enum(["pdf", "docx"]).optional(),
    }).optional(),
});

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

interface GeneratedResumeRow {
    id: string;
    userId: string;
    applicationId: string | null;
    createdAt: Date;
    templateKey: string;
    format: string;
    status: string;
    artifactPath: string | null;
    error: string | null;
}

function summarizeResumeRow(r: GeneratedResumeRow) {
    return {
        id: r.id,
        userId: r.userId,
        applicationId: r.applicationId,
        createdAt: r.createdAt.toISOString(),
        templateKey: r.templateKey,
        format: r.format,
        status: r.status,
        hasArtifact: r.artifactPath !== null,
        error: r.error,
    };
}

export async function GET(req: NextRequest) {
    const guard = await requireSession();
    if ('error' in guard) return guard.error;
    const userId = userIdFromGuard(guard);
    if (!userId) return NextResponse.json({ error: "Session missing user.id" }, { status: 401 });

    const url = new URL(req.url);
    const applicationId = url.searchParams.get("applicationId");
    const limitRaw = Number(url.searchParams.get("limit") ?? 50);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(1, Math.floor(limitRaw)), 200) : 50;

    const where: Record<string, unknown> = { userId };
    if (applicationId) where.applicationId = applicationId;

    try {
        const rows = await prisma.generatedResume.findMany({
            where,
            orderBy: { createdAt: "desc" },
            take: limit,
        });
        return NextResponse.json({ resumes: rows.map(summarizeResumeRow) }, { status: 200 });
    } catch (e) {
        console.error("[resumes GET] error:", e);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}

export async function POST(req: NextRequest) {
    const guard = await requireSession();
    if ('error' in guard) return guard.error;
    const userId = userIdFromGuard(guard);
    if (!userId) return NextResponse.json({ error: "Session missing user.id" }, { status: 401 });

    const parsed = ResumePostBodySchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
        return NextResponse.json({ error: parsed.error.issues, stage: "input" }, { status: 400 });
    }

    let stage: "load" | "parse" | "select" | "rewrite" | "render" = "load";
    try {
        // 1. Load profile
        const hydrated = await findOrCreateProfile(userId);
        // Date → ISO string normalization for downstream ProfileWire-typed code.
        const profile = JSON.parse(JSON.stringify(hydrated)) as ProfileWire;

        if (profile.workRoles.length === 0 && profile.projects.length === 0) {
            return NextResponse.json(
                { error: "Profile is empty — add at least one work role or project before generating.", stage: "load" },
                { status: 400 },
            );
        }

        // 2. Parse posting
        stage = "parse";
        const posting = await parsePosting(parsed.data.posting);

        // 3. Select bullets
        stage = "select";
        const selection = selectBullets(profile, posting.keywords);
        const flat = flattenSelections(selection);
        if (flat.length === 0) {
            return NextResponse.json(
                { error: "No bullets matched the posting and none are locked/recent — add tags or bullets to your profile.", stage: "select" },
                { status: 400 },
            );
        }
        console.info(`[resume] selected ${flat.length} bullets across ${selection.workRoles.length}+${selection.projects.length}+${selection.education.length} entities`);

        // 4. Rewrite via LLM
        stage = "rewrite";
        const rewrites = await rewriteBullets(flat, posting);

        // 4b. Skills gap (story 41) — pure, no LLM. Compute against the
        // FULL profile, not just the selected bullets: even an unselected
        // bullet counts as coverage for the keyword it mentions.
        const skillsGap = computeSkillsGap(profile, posting.keywords);

        // 5. Render
        stage = "render";
        const format = parsed.data.options?.format ?? "pdf";
        const props = composeResumeProps(profile, selection, rewrites);
        const bytes = format === "docx"
            ? await renderResumeDOCX(props)
            : await renderResumePDF(props);

        const companySlug = sanitizeFilenamePart(posting.company ?? "resume");
        const dateSlug = new Date().toISOString().slice(0, 10);
        const filename = `resume-${companySlug || "untitled"}-${dateSlug}.${format}`;

        // 6. Persist (M8-2.2). Write artifact first; if that fails we never
        // create the row (no orphan rows pointing at missing files). If the row
        // insert fails afterward, we'd have an orphan FILE — manual cleanup,
        // but the user still got their resume in the response.
        const applicationId = parsed.data.applicationId?.trim() || null;
        // Defensive: if applicationId is supplied, verify ownership before linking.
        if (applicationId) {
            const ownedApp = await prisma.application.findFirst({
                where: { id: applicationId, userId },
                select: { id: true },
            });
            if (!ownedApp) {
                return NextResponse.json(
                    { error: "applicationId references an application that isn't yours", stage: "input" },
                    { status: 400 },
                );
            }
        }
        let resumeId = "";
        try {
            const row = await prisma.generatedResume.create({
                data: {
                    userId,
                    applicationId,
                    postingInput: JSON.stringify({
                        url: parsed.data.posting.url ?? null,
                        text: parsed.data.posting.text ? parsed.data.posting.text.slice(0, 4_000) : null,
                        sourceUrl: posting.sourceUrl,
                        title: posting.title,
                        company: posting.company,
                        parsedKeywords: posting.keywords,
                    }),
                    profileSnapshot: JSON.stringify(profile),
                    selections: JSON.stringify(flat.map(s => ({
                        kind: s.kind,
                        sourceId: s.sourceId,
                        sourceLabel: s.sourceLabel,
                        bulletId: s.bulletId,
                        originalText: s.originalText,
                        rewrittenText: rewrites.find(r => r.id === s.bulletId)?.rewrittenText ?? s.originalText,
                        score: Number.isFinite(s.score) ? s.score : -1, // Infinity serializes as null
                        matchedTags: s.matchedTags,
                        matchedKeywords: s.matchedKeywords,
                        locked: s.locked,
                    }))),
                    skillsGap: JSON.stringify(skillsGap.missing),
                    templateKey: parsed.data.options?.template ?? "ats-plain",
                    format,
                    status: "ready",
                },
                select: { id: true },
            });
            resumeId = row.id;
            // PB-9 (was RAH-14): write the file, then update the row. If the update fails
            // after a successful write, we have to roll back the file write
            // and mark the row errored — otherwise the FS accumulates orphan
            // artifacts and the row sits at status="ready" with no path, so
            // /api/resumes/[id]/download 404s while the row keeps showing up
            // in the list.
            let artifactPath: string | null = null;
            try {
                artifactPath = await writeResumeArtifact(resumeId, format, bytes);
                await prisma.generatedResume.update({
                    where: { id: resumeId },
                    data: { artifactPath },
                });
            } catch (innerErr) {
                if (artifactPath) {
                    await deleteResumeArtifact(artifactPath).catch(cleanupErr =>
                        console.warn(`[resume POST] orphan artifact cleanup failed for ${resumeId}:`, cleanupErr)
                    );
                }
                await prisma.generatedResume.update({
                    where: { id: resumeId },
                    data: {
                        status: "errored",
                        error: innerErr instanceof Error ? innerErr.message : String(innerErr),
                    },
                }).catch(updateErr =>
                    console.warn(`[resume POST] errored-status update failed for ${resumeId}:`, updateErr)
                );
                throw innerErr;
            }
        } catch (e) {
            // Persistence is best-effort: don't fail the user's generation just
            // because we couldn't archive. The bytes go back to them either way.
            console.warn(`[resume POST] persistence failed (id=${resumeId || "<not created>"}):`, e);
        }

        // PB-12 (was RAH-22): HTTP header values must be ASCII (undici's Headers throws on
        // non-Latin1 chars). LLM-extracted strings often carry em-dashes,
        // smart quotes, or accented chars that would 500 the whole response.
        const asciiHeader = (s: string | null | undefined) =>
            (s ?? "").replace(/[^\x20-\x7e]/g, "");

        return new NextResponse(new Uint8Array(bytes), {
            status: 200,
            headers: {
                "Content-Type": FORMAT_CONTENT_TYPES[format],
                "Content-Length": String(bytes.length),
                "Content-Disposition": `attachment; filename="${filename}"`,
                "Cache-Control": "no-store",
                "X-Resume-Title": asciiHeader(posting.title),
                "X-Resume-Company": asciiHeader(posting.company),
                "X-Resume-Format": format,
                ...(resumeId ? { "X-Resume-Id": resumeId } : {}),
            },
        });
    } catch (e) {
        console.error(`[resume POST] stage=${stage} error:`, e);
        if (e instanceof AIError) {
            return NextResponse.json({ error: e.message, stage, aiStage: e.stage }, { status: 502 });
        }
        const msg = e instanceof Error ? e.message : "Internal Server Error";
        return NextResponse.json({ error: msg, stage }, { status: 500 });
    }
}
