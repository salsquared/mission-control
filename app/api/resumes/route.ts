import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/auth-guards";
import { findOrCreateProfile } from "@/lib/repositories/profile";
import { parsePosting } from "@/lib/resumes/posting";
import { selectBullets, flattenSelections } from "@/lib/resumes/select";
import { rewriteBullets } from "@/lib/resumes/rewrite";
import { composeResumeProps } from "@/lib/resumes/templates/ats-plain";
import { renderResumePDF } from "@/lib/resumes/render-pdf";
import { renderResumeDOCX } from "@/lib/resumes/render-docx";
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

        return new NextResponse(new Uint8Array(bytes), {
            status: 200,
            headers: {
                "Content-Type": FORMAT_CONTENT_TYPES[format],
                "Content-Length": String(bytes.length),
                "Content-Disposition": `attachment; filename="${filename}"`,
                "Cache-Control": "no-store",
                "X-Resume-Title": posting.title ?? "",
                "X-Resume-Company": posting.company ?? "",
                "X-Resume-Format": format,
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
