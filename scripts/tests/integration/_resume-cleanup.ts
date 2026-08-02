/**
 * Shared teardown for the integration suites that generate a resume.
 *
 * NOT A SUITE — the leading underscore marks it as scaffolding, and
 * `scripts/test-integration.sh` runs a hand-maintained `SUITES` array rather
 * than a glob, so this file is never executed on its own.
 *
 * Why it exists: `POST /api/resumes` writes a `GeneratedResume` row AND a file
 * under `data/resumes/` as a side effect of the request. Neither is created by
 * the calling script, so neither was in the `created[]` list the suites tear
 * down — every run since 2026-05-15 left both behind. By 2026-08-02 that was
 * **10 orphaned rows and 10 orphaned artifacts** in dev.db across
 * `resume-e2e-smoke` and `resume-docx-smoke`, indistinguishable in the
 * "Previous resumes" dropdown from the owner's real ones.
 *
 * It lives in one file rather than being pasted into both suites precisely
 * because this bug WAS cleanup drift: two copies are two things to forget.
 *
 * Best-effort by design — teardown must never turn a passing run red, and a
 * missing row or already-deleted file is the expected outcome on a re-run.
 */
import type { PrismaClient } from "@prisma/client";
import { deleteResumeArtifact } from "@/lib/resumes/storage";

/**
 * Delete a generated resume and its artifact file.
 *
 * @param prisma the suite's own client (these scripts each construct one).
 * @param resumeId value of the `X-Resume-Id` response header; null when the
 *   request failed before a row was created, in which case there is nothing
 *   to clean and this is a no-op.
 */
export async function deleteGeneratedResume(
    prisma: PrismaClient,
    resumeId: string | null,
): Promise<void> {
    if (!resumeId) return;

    // Read the row first: `artifactPath` is written by the route AFTER the row
    // is created, so it is the only record of which file on disk belongs to
    // this resume. Delete the file before the row, or the path is lost.
    const row = await prisma.generatedResume
        .findUnique({ where: { id: resumeId }, select: { artifactPath: true } })
        .catch(() => null);

    if (row?.artifactPath) {
        // Through the storage module rather than a hand-rolled unlink, so the
        // path resolution and its safeRelative() guard stay in one place.
        await deleteResumeArtifact(row.artifactPath).catch(() => undefined);
    }

    await prisma.generatedResume.delete({ where: { id: resumeId } }).catch(() => undefined);
    console.log(`[cleanup] removed generated resume ${resumeId}${row?.artifactPath ? ` + ${row.artifactPath}` : ""}`);
}
