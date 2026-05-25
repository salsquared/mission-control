import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth-guards";
import { checkUserRateLimit } from "@/lib/api/user-rate-limit";
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

// M8.4.5 (story S8.12) — `applicationId` extends the posting input. When set
// the route loads the linked Application + its JobPosting and uses the
// posting.sourceUrl as the canonical url for the parse step, then auto-attaches
// the resulting GeneratedResume to that application (per [[S8.6]]). The
// existing top-level body `applicationId` (M8-2.4) still works for URL / Paste
// flows that want to attach without going through the Pipeline picker.
const PostingInputSchema = z.object({
    url: z.string().url().optional(),
    text: z.string().optional(),
    applicationId: z.string().cuid().optional(),
}).refine(
    p => (p.url && p.url.trim().length > 0) || (p.text && p.text.trim().length > 0) || (p.applicationId && p.applicationId.trim().length > 0),
    { message: "Provide one of: url, text, or applicationId" },
);

const ResumePostBodySchema = z.object({
    posting: PostingInputSchema,
    applicationId: z.string().optional(), // attaches the GeneratedResume to an Application (M8-2.4)
    options: z.object({
        template: z.literal("ats-plain").optional(),
        format: z.enum(["pdf", "docx"]).optional(),
    }).optional(),
});

// GET projection cap. Default 100 per M8.4.3; max 500 above which the dropdown
// becomes paginate-or-search territory (OOS for M8.4 v1).
const ResumeListLimitSchema = z.coerce.number().int().positive().max(500).default(100);

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
    // M8.4.3 — surfaced to the previous-resumes dropdown so the UI shows
    // company + title at a glance. NULL on rows generated before M8.4.2 added
    // these columns; the dropdown renders "(unknown)" / "(no title)" for those.
    postingTitle: string | null;
    postingCompany: string | null;
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
        postingTitle: r.postingTitle,
        postingCompany: r.postingCompany,
    };
}

export async function GET(req: NextRequest) {
    const guard = await requireSession();
    if ('error' in guard) return guard.error;
    const userId = userIdFromGuard(guard);
    if (!userId) return NextResponse.json({ error: "Session missing user.id" }, { status: 401 });

    const url = new URL(req.url);
    const applicationId = url.searchParams.get("applicationId");
    const limitParam = url.searchParams.get("limit");
    // M8.4.3 — coerce + clamp via zod. Bad input falls back to the default
    // (100) rather than 400'ing the request — the dropdown still needs to
    // render something even if a stale link carries a malformed limit.
    const limitParsed = ResumeListLimitSchema.safeParse(limitParam ?? undefined);
    const limit = limitParsed.success ? limitParsed.data : 100;

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

    // RAH-12: per-userId rate limit BEFORE any Gemini-touching code runs.
    // Defense-in-depth against an accidental refresh loop or runaway client
    // burning through the daily generation budget (1 generate = 2-3 Gemini
    // calls). 5 per 10 minutes is a generous human cap while still bounding
    // a stuck loop.
    const rl = checkUserRateLimit("resumes:gen", userId, Date.now(), { max: 5, windowMs: 10 * 60 * 1000 });
    if (!rl.ok) {
        return NextResponse.json(
            { error: `Too many resume generations — try again in ${rl.retryAfterSec}s`, stage: "rate-limit" },
            { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } },
        );
    }

    const parsed = ResumePostBodySchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
        return NextResponse.json({ error: parsed.error.issues, stage: "input" }, { status: 400 });
    }

    let stage: "load" | "parse" | "select" | "rewrite" | "render" = "load";
    try {
        // M8.4.5 (story S8.12) — Pipeline-picker source. When the body carries
        // `posting.applicationId`, resolve that into the canonical posting
        // sourceUrl + auto-link the resulting GeneratedResume to the
        // application. Four guards, all 4xx, all fire before the heavy parse /
        // LLM / render path:
        //   1. Application exists and belongs to the session user → 404 on
        //      cross-user mismatch (don't leak existence).
        //   2. Application.status === 'INTERESTED' → 400 application-not-interested
        //      (defense-in-depth; the picker UI only surfaces INTERESTED).
        //   3. Application.posting?.sourceUrl is non-null → 400
        //      application-missing-url (Decision 6.4: URL-less apps shouldn't
        //      reach this code path via the picker, but a hand-built request
        //      might bypass the picker).
        // Resolution sets posting.url to the application's posting sourceUrl;
        // the parse step downstream treats it as a normal URL input.
        const pickerApplicationId = parsed.data.posting.applicationId?.trim();
        let autoLinkApplicationId: string | null = null;
        if (pickerApplicationId) {
            const application = await prisma.application.findUnique({
                where: { id: pickerApplicationId },
                include: { posting: true },
            });
            if (!application || application.userId !== userId) {
                // Cross-user (or nonexistent) — 404 rather than 403 to avoid
                // leaking the existence of a cuid you don't own.
                return NextResponse.json({ error: "Application not found", stage: "input" }, { status: 404 });
            }
            if (application.status !== 'INTERESTED') {
                return NextResponse.json(
                    { error: "application-not-interested", stage: "input" },
                    { status: 400 },
                );
            }
            const sourceUrl = application.posting?.sourceUrl;
            if (!sourceUrl || sourceUrl.trim().length === 0) {
                return NextResponse.json(
                    { error: "application-missing-url", stage: "input" },
                    { status: 400 },
                );
            }
            // Rewrite the parsed body to feed the parse step a URL it already
            // knows is safe (cuid was validated by zod, sourceUrl is whatever
            // the watchlist fetcher persisted — assertExternalHttpUrl in
            // parsePosting still gates SSRF).
            parsed.data.posting.url = sourceUrl;
            autoLinkApplicationId = application.id;
        }

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
        // Story S9.5 — build per-project README context once before the rewrite
        // call. Only includes READMEs for projects whose bullets are actually
        // in the selection AND that have a stored README (`portfolio=true`
        // + scheduler fetched it). Keeps the prompt-budget bounded to the
        // projects that matter for this specific resume.
        const projectIdsInSelection = new Set(
            flat.filter(s => s.kind === "project").map(s => s.sourceId),
        );
        const readmesBySourceId: Record<string, string> = {};
        for (const project of profile.projects) {
            if (projectIdsInSelection.has(project.id)) {
                // ProjectWire doesn't include the readme field on its zod shape,
                // but the hydrated profile DOES carry it through from the DB.
                // Treat the field defensively.
                const r = (project as unknown as { readme?: string | null }).readme;
                if (typeof r === "string" && r.trim().length > 0) {
                    readmesBySourceId[project.id] = r;
                }
            }
        }
        const rewrites = await rewriteBullets(flat, posting, { readmesBySourceId });

        // 4b. Skills gap (story S8.8) — pure, no LLM. Compute against the
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
        //
        // M8.4.5 step 6 — when the body carried `posting.applicationId`, we
        // resolved it to `autoLinkApplicationId` above; that takes precedence
        // over the legacy top-level `applicationId` (M8-2.4) so the Pipeline
        // flow always wins. Both paths still cross-check ownership.
        const topLevelApplicationId = parsed.data.applicationId?.trim() || null;
        const applicationId = autoLinkApplicationId ?? topLevelApplicationId;
        // Defensive: ownership check for the LEGACY top-level applicationId.
        // (The picker path's `autoLinkApplicationId` was already ownership-
        // gated above with cross-user 404 semantics.)
        if (applicationId && applicationId === topLevelApplicationId && autoLinkApplicationId === null) {
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
                    // M8.4.2 — persist the parsed title + company alongside the
                    // existing X-Resume-Title / X-Resume-Company response
                    // headers. Drives the previous-resumes dropdown UI (M8.4.6).
                    postingTitle: posting.title,
                    postingCompany: posting.company,
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
