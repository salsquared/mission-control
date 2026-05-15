import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guards";
import { broadcastEvent } from "@/lib/events";
import { extractText } from "@/lib/profile/extract";
import { extractProfileFromText } from "@/lib/profile/import-llm";
import { mergeImports, type ExistingProfileForMerge } from "@/lib/profile/merge";
import {
    findOrCreateProfile,
    updateProfileHeader,
    createWorkRole,
    updateWorkRole,
    createProject,
    updateProject,
    createEducation,
    updateEducation,
} from "@/lib/repositories/profile";
import { AIError } from "@/lib/ai/gemini";

export const runtime = "nodejs";
// LLM + multi-file extraction can be slow with multiple resumes.
export const maxDuration = 120;

const MAX_FILES = 8;
const MAX_BYTES_PER_FILE = 8 * 1024 * 1024; // 8 MB

function userIdFromGuard(guard: { session: { user?: unknown } }): string | null {
    const user = guard.session.user as { id?: string } | undefined;
    return user?.id && user.id.length > 0 ? user.id : null;
}

export async function POST(req: NextRequest) {
    const guard = await requireSession();
    if ('error' in guard) return guard.error;
    const userId = userIdFromGuard(guard);
    if (!userId) return NextResponse.json({ error: "Session missing user.id" }, { status: 401 });

    let formData: FormData;
    try {
        formData = await req.formData();
    } catch {
        return NextResponse.json({ error: "Expected multipart/form-data with one or more 'files' parts", stage: "input" }, { status: 400 });
    }

    const files = formData.getAll("files").filter((v): v is File => v instanceof File);
    if (files.length === 0) {
        return NextResponse.json({ error: "No files in upload — attach at least one resume.", stage: "input" }, { status: 400 });
    }
    if (files.length > MAX_FILES) {
        return NextResponse.json({ error: `Too many files (${files.length}). Limit is ${MAX_FILES} per import.`, stage: "input" }, { status: 400 });
    }
    for (const f of files) {
        if (f.size > MAX_BYTES_PER_FILE) {
            return NextResponse.json({ error: `${f.name} is ${(f.size / 1024 / 1024).toFixed(1)} MB — limit is ${MAX_BYTES_PER_FILE / 1024 / 1024} MB.`, stage: "input" }, { status: 400 });
        }
    }

    let stage: "extract" | "analyze" | "merge" | "write" = "extract";
    try {
        // 1. Extract text from each file
        const extracted: { filename: string; text: string }[] = [];
        for (const f of files) {
            const buf = Buffer.from(await f.arrayBuffer());
            const e = await extractText(buf, f.type, f.name);
            extracted.push({ filename: e.filename, text: e.text });
        }

        // 2. LLM-extract a structured tree per file
        stage = "analyze";
        const trees: { filename: string; tree: import("@/lib/profile/import-llm").ExtractedProfile }[] = [];
        for (const e of extracted) {
            const tree = await extractProfileFromText(e.text, e.filename);
            trees.push({ filename: e.filename, tree });
        }

        // 3. Load existing profile and merge
        stage = "merge";
        const existing = await findOrCreateProfile(userId);
        const existingForMerge: ExistingProfileForMerge = {
            headline: existing.headline,
            summary: existing.summary,
            location: existing.location,
            email: existing.email,
            phone: existing.phone,
            links: existing.links,
            workRoles: existing.workRoles.map(w => ({
                id: w.id, company: w.company, title: w.title, location: w.location,
                startDate: w.startDate, endDate: w.endDate, bullets: w.bullets,
            })),
            projects: existing.projects.map(p => ({
                id: p.id, name: p.name, description: p.description,
                repoUrl: p.repoUrl, liveUrl: p.liveUrl, bullets: p.bullets,
            })),
            education: existing.education.map(e => ({
                id: e.id, institution: e.institution, degree: e.degree, field: e.field,
                startDate: e.startDate, endDate: e.endDate, bullets: e.bullets,
            })),
        };
        const merge = mergeImports(existingForMerge, trees);

        // 4. Apply writes — one repository call per change. Not a single Prisma
        // transaction (each call already does its own). Acceptable trade-off
        // for MVP; the existing profile API isn't transactional either.
        stage = "write";
        if (merge.headerPatch) {
            await updateProfileHeader(userId, merge.headerPatch);
        }
        for (const u of merge.workRoleUpdates) {
            await updateWorkRole(userId, u.existingId, { bullets: u.bullets });
        }
        for (const c of merge.workRolesToCreate) {
            await createWorkRole(userId, c);
        }
        for (const u of merge.projectUpdates) {
            await updateProject(userId, u.existingId, { bullets: u.bullets });
        }
        for (const c of merge.projectsToCreate) {
            await createProject(userId, c);
        }
        for (const u of merge.educationUpdates) {
            await updateEducation(userId, u.existingId, { bullets: u.bullets });
        }
        for (const c of merge.educationToCreate) {
            await createEducation(userId, c);
        }

        broadcastEvent({ model: 'Profile', action: 'upsert', id: existing.id, timestamp: Date.now() });

        return NextResponse.json({
            success: true,
            counts: merge.counts,
            perFile: merge.perFile,
        }, { status: 200 });
    } catch (e) {
        console.error(`[profile/import POST] stage=${stage} error:`, e);
        if (e instanceof AIError) {
            return NextResponse.json({ error: e.message, stage, aiStage: e.stage }, { status: 502 });
        }
        const msg = e instanceof Error ? e.message : "Internal Server Error";
        return NextResponse.json({ error: msg, stage }, { status: 500 });
    }
}
