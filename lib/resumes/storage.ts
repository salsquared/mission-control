/**
 * Filesystem-backed storage for GeneratedResume artifacts (M8 Phase 2).
 *
 * Layout:  data/resumes/<id>.<ext>
 *
 * The DB row holds the metadata + the relative path (`artifactPath`); the
 * bytes live on disk. Filesystem chosen over DB Bytes per implementation.md
 * §M8-2.1 — smaller DB, faster I/O, accepts the trade-off of possible
 * row/file divergence (easy to clean up manually if it ever happens).
 */
import { mkdir, writeFile, readFile, unlink } from "node:fs/promises";
import { join, isAbsolute, normalize, sep } from "node:path";

const STORAGE_ROOT = join(process.cwd(), "data", "resumes");

export type ResumeFormat = "pdf" | "docx";

function safeRelative(filename: string): string {
    // Defense in depth: reject anything that looks like a path traversal or
    // an absolute path. The id we pass is a cuid (alnum) so this should never
    // trip in practice — but a single hand-rolled callsite shouldn't be able
    // to point us at /etc/passwd.
    const normalized = normalize(filename);
    if (isAbsolute(normalized) || normalized.includes("..") || normalized.startsWith(sep)) {
        throw new Error(`Unsafe artifact filename: ${filename}`);
    }
    return normalized;
}

export async function writeResumeArtifact(
    id: string,
    format: ResumeFormat,
    bytes: Buffer,
): Promise<string> {
    await mkdir(STORAGE_ROOT, { recursive: true });
    const filename = safeRelative(`${id}.${format}`);
    const fullPath = join(STORAGE_ROOT, filename);
    await writeFile(fullPath, bytes);
    return filename; // store as relative path; caller saves to artifactPath column
}

export async function readResumeArtifact(artifactPath: string): Promise<Buffer> {
    const filename = safeRelative(artifactPath);
    const fullPath = join(STORAGE_ROOT, filename);
    return readFile(fullPath);
}

export async function deleteResumeArtifact(artifactPath: string): Promise<void> {
    const filename = safeRelative(artifactPath);
    const fullPath = join(STORAGE_ROOT, filename);
    await unlink(fullPath).catch(() => undefined);
}
