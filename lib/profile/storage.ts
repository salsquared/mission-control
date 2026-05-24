/**
 * Filesystem-backed storage for ResumeUpload archive bytes (M7.6.2).
 *
 * Layout:  data/resume-uploads/<uploadId>.<ext>
 *
 * Mirrors the lib/resumes/storage.ts pattern: the DB row holds metadata +
 * the relative path (`ResumeUpload.artifactPath`); the original upload bytes
 * live on disk. Append-only — the import route writes here once per upload
 * and never mutates afterward. Bytes are absent (artifactPath null) for
 * pasted-JSON imports that never had a binary form.
 */
import { mkdir, writeFile, readFile, unlink } from "node:fs/promises";
import { join, isAbsolute, normalize, sep } from "node:path";

const STORAGE_ROOT = join(process.cwd(), "data", "resume-uploads");

function normalizeExt(ext: string): string {
    return ext.replace(/^\.+/, "").toLowerCase();
}

function safeRelative(filename: string): string {
    // Defense in depth (mirrors lib/resumes/storage.ts safeRelative + RAH-21):
    // archives are always flat under STORAGE_ROOT, named by uploadId + ext.
    // Reject path traversal, absolute paths, OR any embedded path separator —
    // so a future hand-rolled callsite trying to store "subdir/x.pdf" fails
    // loudly here rather than silently writing under STORAGE_ROOT/subdir/.
    const normalized = normalize(filename);
    if (
        isAbsolute(normalized)
        || normalized.includes("..")
        || normalized.startsWith(sep)
        || normalized.includes(sep)
    ) {
        throw new Error(`Unsafe resume-upload filename: ${filename}`);
    }
    return normalized;
}

export async function writeResumeUpload(
    uploadId: string,
    ext: string,
    bytes: Buffer | Uint8Array,
): Promise<string> {
    const normExt = normalizeExt(ext);
    // safeRelative also rejects a separator in uploadId itself — calling it
    // on the combined filename below catches that case, but doing the check
    // up front makes the failure mode obvious if uploadId is ever caller-
    // supplied rather than a Prisma-generated cuid.
    safeRelative(uploadId);
    await mkdir(STORAGE_ROOT, { recursive: true });
    const filename = safeRelative(`${uploadId}.${normExt}`);
    const fullPath = join(STORAGE_ROOT, filename);
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    await writeFile(fullPath, buf);
    // Return the relative path from repo root so callers can stash it in
    // ResumeUpload.artifactPath as-is (matches GeneratedResume.artifactPath
    // semantics where the column already carries data/resumes/ prefix-free
    // values — but here we include the directory prefix for symmetry with
    // how readResumeUpload's signature takes the bare uploadId).
    return join("data", "resume-uploads", filename);
}

export async function readResumeUpload(uploadId: string, ext: string): Promise<Buffer> {
    const normExt = normalizeExt(ext);
    safeRelative(uploadId);
    const filename = safeRelative(`${uploadId}.${normExt}`);
    const fullPath = join(STORAGE_ROOT, filename);
    return readFile(fullPath);
}

export async function deleteResumeUpload(uploadId: string, ext: string): Promise<void> {
    const normExt = normalizeExt(ext);
    safeRelative(uploadId);
    const filename = safeRelative(`${uploadId}.${normExt}`);
    const fullPath = join(STORAGE_ROOT, filename);
    try {
        await unlink(fullPath);
    } catch (e) {
        // Tolerate missing files — the row may have been a JSON-paste import
        // with no on-disk artifact, or a previous best-effort write may have
        // failed silently. Log but never throw.
        console.warn(`[profile/storage] deleteResumeUpload missing or unlink failed for ${filename}:`, e);
    }
}
