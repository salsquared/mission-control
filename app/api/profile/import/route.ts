import { NextRequest, NextResponse } from "next/server";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth-guards";
import { checkUserRateLimit } from "@/lib/api/user-rate-limit";
import { broadcastEvent } from "@/lib/events";
import { extractText } from "@/lib/profile/extract";
import { extractProfileFromText } from "@/lib/profile/import-llm";
import { synthesizeMasterResume } from "@/lib/profile/synthesize";
import { mergeImports, type ExistingProfileForMerge } from "@/lib/profile/merge";
import { writeResumeUpload } from "@/lib/profile/storage";
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

const RAW_TEXT_CAP = 200_000;

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

    // RAH-12: per-userId rate limit BEFORE any file/LLM work. Each import
    // spawns N (extract → synthesize → merge) Gemini calls per file, so 5
    // imports per 10 minutes is a generous human cap. A stuck loop posting
    // multipart payloads would otherwise sustain real cost.
    const rl = checkUserRateLimit("profile:import", userId, Date.now(), { max: 5, windowMs: 10 * 60 * 1000 });
    if (!rl.ok) {
        return NextResponse.json(
            { error: `Too many profile imports — try again in ${rl.retryAfterSec}s`, stage: "rate-limit" },
            { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } },
        );
    }

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

    // M7.6.2 — every file in this multipart call shares one importBatchId so
    // a UI can later show "the three resumes I uploaded together on date X".
    // Using globalThis.crypto.randomUUID for parity with lib/profile/bullets.ts
    // (no cuid lib is installed; UUID is opaque enough for grouping).
    const importBatchId = globalThis.crypto.randomUUID();

    let stage: "extract" | "analyze" | "synthesize" | "merge" | "write" = "extract";
    try {
        // 1. Extract text from each file. Buffer kept around per-file for the
        // M7.6.2 archive write below — extractText doesn't expose the original
        // bytes, and re-reading f.arrayBuffer() after consumption is undefined.
        const extracted: { file: File; filename: string; text: string; buf: Buffer }[] = [];
        for (const f of files) {
            const buf = Buffer.from(await f.arrayBuffer());
            const e = await extractText(buf, f.type, f.name);
            extracted.push({ file: f, filename: e.filename, text: e.text, buf });
        }

        // 2. LLM-extract a structured tree per file
        stage = "analyze";
        const trees: { filename: string; tree: import("@/lib/profile/import-llm").ExtractedProfile }[] = [];
        for (const e of extracted) {
            const tree = await extractProfileFromText(e.text, e.filename);
            trees.push({ filename: e.filename, tree });
        }

        // 2b. M7.6.2 — archive every uploaded file as a ResumeUpload row +
        // (when binary) bytes on disk. Best-effort: any failure logs a warning
        // and continues; the user's merge must succeed even if archive fails.
        // Wedged between LLM analyze and synthesize because both the raw text
        // AND the structured tree are now available; running it after merge
        // would lose the per-file tree (synthesize consolidates them).
        for (let i = 0; i < extracted.length; i++) {
            const e = extracted[i];
            const tree = trees[i].tree;
            const wasTruncated = e.text.length > RAW_TEXT_CAP;
            if (wasTruncated) {
                console.warn(`[M7.6.2] rawText for ${e.file.name} truncated from ${e.text.length} to ${RAW_TEXT_CAP} bytes`);
            }
            let row: { id: string } | null = null;
            try {
                row = await prisma.resumeUpload.create({
                    data: {
                        userId,
                        filename: e.file.name,
                        mimeType: e.file.type,
                        sizeBytes: e.file.size,
                        rawText: e.text.slice(0, RAW_TEXT_CAP),
                        parsedJson: JSON.stringify(tree),
                        importBatchId,
                        artifactPath: null,
                    },
                    select: { id: true },
                });
            } catch (err) {
                console.warn(`[M7.6.2] archive write failed for ${e.file.name}: ${err instanceof Error ? err.message : String(err)}`);
            }
            if (row) {
                // Only persist bytes when the original upload had a usable
                // extension. JSON-paste imports and zero-byte extensions stay
                // metadata-only (artifactPath remains null per schema comment).
                const ext = path.extname(e.file.name).slice(1).toLowerCase();
                if (ext && e.buf.length > 0) {
                    try {
                        const returnedPath = await writeResumeUpload(row.id, ext, e.buf);
                        await prisma.resumeUpload.update({
                            where: { id: row.id },
                            data: { artifactPath: returnedPath },
                        });
                    } catch (err) {
                        console.warn(`[M7.6.2] archive write failed for ${e.file.name}: ${err instanceof Error ? err.message : String(err)}`);
                    }
                }
            }
        }

        // 3. Load existing profile so the synthesizer + merge step can dedup
        // against what the user already has.
        const existing = await findOrCreateProfile(userId);
        const existingForMerge: ExistingProfileForMerge = {
            headline: existing.headline,
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

        // 4. Synthesize the master resume — one Flash call that consolidates
        // every per-file draft + existing entities into a single canonical
        // tree. Resolves role-vs-project misclassifications across files,
        // dedupes entities, sorts reverse-chrono. Short-circuited inside
        // synthesizeMasterResume (canSkipSynthesis) for the common first-import
        // case — a single file into an empty profile has nothing to consolidate,
        // so the extraction is returned verbatim with no Flash call.
        stage = "synthesize";
        const synthesized = await synthesizeMasterResume(existingForMerge, trees);

        // 5. Deterministic merge applies the synthesized tree to the DB with
        // append-never-overwrite semantics + cross-category dedup safety net.
        stage = "merge";
        const merge = mergeImports(existingForMerge, [
            { filename: "(synthesized)", tree: synthesized },
        ]);

        // 6. Apply writes — one repository call per change. Not a single Prisma
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
