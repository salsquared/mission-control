import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth-guards";
import { checkUserRateLimit } from "@/lib/api/user-rate-limit";
import { parsePosting } from "@/lib/resumes/posting";
import { selectBullets, selectProfileExtras, flattenSelections, type ResumeSelection } from "@/lib/resumes/select";
import { rewriteBullets } from "@/lib/resumes/rewrite";
import { tailorResumeTagline, DEFAULT_SECTION_ORDER } from "@/lib/resumes/tagline-tailor";
import { composeResumeProps } from "@/lib/resumes/templates/ats-plain";
import { renderResumePDF } from "@/lib/resumes/render-pdf";
import { writeResumeArtifact, deleteResumeArtifact } from "@/lib/resumes/storage";
import { buildResumeDownloadFilename } from "@/lib/resumes/labels";
import { broadcastEvent } from "@/lib/events";
import { getCanonRow, getCanonSelection } from "@/lib/repositories/canons";
import { reconstructSelection, type StoredSelectionRow } from "@/lib/canons/specialize";
import { resolveSelection } from "@/lib/canons/selection";
import { AIError } from "@/lib/ai/gemini";
import type { ProfileWire } from "@/lib/schemas/profile";

export const runtime = "nodejs";
export const maxDuration = 60;

// Opt-in per-job specialization (docs/canonical-resumes.html §6 Q5 / §7 P5).
// Re-words a canon's CURRENT resume for a specific posting WITHOUT re-selecting
// — the bullet set + layout stay the canon's; only wording + tagline change.
// Saved as a per-job child (isCanonical=false, applicationId set); the canon's
// version chain is untouched.
const BodySchema = z.object({
    canonId: z.string().cuid(),
    applicationId: z.string().cuid(),
});

function userIdFromGuard(guard: { session: { user?: unknown } }): string | null {
    const user = guard.session.user as { id?: string } | undefined;
    return user?.id && user.id.length > 0 ? user.id : null;
}

const asciiHeader = (s: string | null | undefined) => (s ?? "").replace(/[^\x20-\x7e]/g, "");

export async function POST(req: NextRequest) {
    const guard = await requireSession();
    if ("error" in guard) return guard.error;
    const userId = userIdFromGuard(guard);
    if (!userId) return NextResponse.json({ error: "Session missing user.id" }, { status: 401 });

    const rl = checkUserRateLimit("resumes:specialize", userId, Date.now(), { max: 5, windowMs: 10 * 60 * 1000 });
    if (!rl.ok) {
        return NextResponse.json(
            { error: `Too many specializations — try again in ${rl.retryAfterSec}s`, stage: "rate-limit" },
            { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } },
        );
    }

    const parsed = BodySchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
        return NextResponse.json({ error: parsed.error.issues, stage: "input" }, { status: 400 });
    }

    let stage: "load" | "parse" | "rewrite" | "render" = "load";
    try {
        // 1. Canon + its current (latest) canonical resume.
        const canon = await getCanonRow(userId, parsed.data.canonId);
        if (!canon) return NextResponse.json({ error: "Canon not found", stage: "load" }, { status: 404 });
        if (!canon.currentResumeId) {
            return NextResponse.json(
                { error: "Generate the canon's resume before specializing it.", stage: "load" },
                { status: 400 },
            );
        }
        const canonResume = await prisma.generatedResume.findFirst({
            where: { id: canon.currentResumeId, userId },
            select: { selections: true, profileSnapshot: true, tagline: true },
        });
        if (!canonResume) {
            return NextResponse.json({ error: "Canon resume is missing — regenerate it.", stage: "load" }, { status: 400 });
        }

        // 2. The job to specialize for, and its posting URL.
        const application = await prisma.application.findFirst({
            where: { id: parsed.data.applicationId, userId },
            include: { posting: true },
        });
        if (!application) return NextResponse.json({ error: "Application not found", stage: "load" }, { status: 404 });
        const sourceUrl = application.posting?.sourceUrl;
        if (!sourceUrl || sourceUrl.trim().length === 0) {
            return NextResponse.json(
                { error: "application-missing-url", stage: "load" },
                { status: 400 },
            );
        }

        // 3. Parse the specific posting.
        stage = "parse";
        const posting = await parsePosting({ url: sourceUrl });

        // 4. Reconstruct the canon's FIXED selection from its stored rows +
        //    snapshot, refreshing per-bullet matches against THIS posting so the
        //    rewrite emphasizes the right terms. Selection set/order unchanged.
        const profile = JSON.parse(canonResume.profileSnapshot) as ProfileWire;
        // P2.3 (docs/archive/resume-manual-builder.html) — prefer the canon's AUTHORITATIVE
        // manual selection so a per-job specialization can't drift from a curated
        // set edited since the last canon generate. Fall back to reconstructing
        // from the last rendered resume for canons predating the manual builder.
        const manualSelection = await getCanonSelection(userId, canon.id);
        let selection: ResumeSelection;
        if (manualSelection) {
            selection = resolveSelection(profile, manualSelection, posting.keywords);
        } else {
            const stored = JSON.parse(canonResume.selections) as StoredSelectionRow[];
            const fresh = selectBullets(profile, posting.keywords, {}, posting.keywordWeights);
            const matchMap = new Map(
                flattenSelections(fresh).map((s) => [s.bulletId, { matchedTags: s.matchedTags, matchedKeywords: s.matchedKeywords }]),
            );
            selection = reconstructSelection(stored, profile, matchMap);
        }
        const flat = flattenSelections(selection);
        if (flat.length === 0) {
            return NextResponse.json(
                { error: "The canon's resume selection is empty — regenerate the canon first.", stage: "load" },
                { status: 400 },
            );
        }

        // 5. Re-word + re-tagline against the specific posting (no re-select).
        stage = "rewrite";
        const [rewrites, taglineResult] = await Promise.all([
            rewriteBullets(flat, posting),
            tailorResumeTagline({ profile, posting, selection }).catch((e) => {
                console.warn(`[specialize] tagline skipped: ${e instanceof Error ? e.message : e}`);
                return null;
            }),
        ]);
        const tagline = taglineResult?.tagline ?? canonResume.tagline;
        const extras = selectProfileExtras(profile, posting.keywords);

        // 6. Render full-length — the canon selection is already pruned, so we
        //    must NOT re-prune (that would change the set). Keep the canon's
        //    order (DEFAULT_SECTION_ORDER; reconstruction preserved entity order).
        stage = "render";
        const props = composeResumeProps(profile, selection, rewrites, tagline, extras, DEFAULT_SECTION_ORDER);
        const bytes = await renderResumePDF(props);

        const dateSlug = new Date().toISOString().slice(0, 10);
        const filename = buildResumeDownloadFilename(
            {
                userDisplayName: profile.headline?.trim() || null,
                postingTitle: posting.title?.trim() || null,
                postingCompany: posting.company?.trim() || null,
                format: "pdf",
            },
            dateSlug,
        );

        // 7. Persist a per-job CHILD (isCanonical=false → not a version; doesn't
        //    move canon.currentResumeId). Best-effort, like the main route.
        let resumeId = "";
        try {
            const row = await prisma.generatedResume.create({
                data: {
                    userId,
                    applicationId: application.id,
                    canonId: canon.id,
                    isCanonical: false,
                    postingTitle: posting.title,
                    postingCompany: posting.company,
                    tagline,
                    postingInput: JSON.stringify({
                        canonId: canon.id,
                        specializedForApplicationId: application.id,
                        sourceUrl: posting.sourceUrl,
                        title: posting.title,
                        company: posting.company,
                        parsedKeywords: posting.keywords,
                    }),
                    profileSnapshot: JSON.stringify(profile),
                    selections: JSON.stringify(
                        flat.map((s) => ({
                            kind: s.kind,
                            sourceId: s.sourceId,
                            sourceLabel: s.sourceLabel,
                            bulletId: s.bulletId,
                            originalText: s.originalText,
                            rewrittenText: rewrites.find((r) => r.id === s.bulletId)?.rewrittenText ?? s.originalText,
                            score: Number.isFinite(s.score) ? s.score : -1,
                            matchedTags: s.matchedTags,
                            matchedKeywords: s.matchedKeywords,
                            locked: s.locked,
                            ...(s.synthSource ? { synthSource: s.synthSource } : {}),
                        })),
                    ),
                    templateKey: "ats-plain",
                    format: "pdf",
                    status: "ready",
                },
                select: { id: true },
            });
            resumeId = row.id;
            let artifactPath: string | null = null;
            try {
                artifactPath = await writeResumeArtifact(resumeId, "pdf", bytes);
                await prisma.generatedResume.update({ where: { id: resumeId }, data: { artifactPath } });
            } catch (innerErr) {
                if (artifactPath) await deleteResumeArtifact(artifactPath).catch(() => {});
                await prisma.generatedResume
                    .update({ where: { id: resumeId }, data: { status: "errored", error: innerErr instanceof Error ? innerErr.message : String(innerErr) } })
                    .catch(() => {});
                throw innerErr;
            }
        } catch (e) {
            console.warn(`[specialize] persistence failed (id=${resumeId || "<none>"}):`, e);
        }

        if (resumeId) {
            broadcastEvent({ model: "GeneratedResume", action: "upsert", id: resumeId, timestamp: Date.now() });
        }

        return new NextResponse(new Uint8Array(bytes), {
            status: 200,
            headers: {
                "Content-Type": "application/pdf",
                "Content-Length": String(bytes.length),
                "Content-Disposition": `attachment; filename="${filename}"`,
                "Cache-Control": "no-store",
                "X-Resume-Title": asciiHeader(posting.title),
                "X-Resume-Company": asciiHeader(posting.company),
                "X-Resume-Format": "pdf",
                ...(resumeId ? { "X-Resume-Id": resumeId } : {}),
            },
        });
    } catch (e) {
        console.error(`[specialize] stage=${stage} error:`, e);
        if (e instanceof AIError) {
            return NextResponse.json({ error: e.message, stage, aiStage: e.stage }, { status: 502 });
        }
        const msg = e instanceof Error ? e.message : "Internal Server Error";
        return NextResponse.json({ error: msg, stage }, { status: 500 });
    }
}
