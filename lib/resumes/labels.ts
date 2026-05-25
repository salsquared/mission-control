/**
 * Canonical naming for generated resumes — used by:
 *   - POST /api/resumes Content-Disposition (the download filename the
 *     browser saves)
 *   - GET /api/resumes/[id]/download Content-Disposition (same, on
 *     historical replays)
 *   - the previous-resumes dropdown label in GenerateResumeCard
 *
 * Display format (commas, fine in UI):
 *   "Salvador Salcedo, Software Engineer Intern, Rocket Lab Resume"
 *
 * Filename format (dashes for cross-OS / shell safety):
 *   "Salvador Salcedo - Software Engineer Intern - Rocket Lab Resume.pdf"
 *
 * Both gracefully degrade when one or more fields are missing.
 */

export interface ResumeLabelParts {
    userDisplayName: string | null;
    postingTitle: string | null;
    postingCompany: string | null;
}

// Strip characters that are problematic in cross-OS filenames. Spaces are
// fine on modern macOS/Linux/Windows; commas are fine but awkward in
// shells, so the filename builder uses " - " instead.
//   Disallowed:  \ / : * ? " < > |  + control chars  + leading/trailing dots
// Also collapses runs of whitespace to a single space and trims.
export function sanitizeFilenameSegment(s: string): string {
    return s
        // eslint-disable-next-line no-control-regex
        .replace(/[\\/:*?"<>|\x00-\x1f]+/g, "")
        .replace(/\s+/g, " ")
        .replace(/^\.+|\.+$/g, "")
        .trim();
}

// "Salvador Salcedo, Software Engineer Intern, Rocket Lab Resume"
// Falls back gracefully on missing fields; returns null if none present.
export function buildResumeDisplayLabel(parts: ResumeLabelParts): string | null {
    const segments: string[] = [];
    if (parts.userDisplayName?.trim()) segments.push(parts.userDisplayName.trim());
    if (parts.postingTitle?.trim()) segments.push(parts.postingTitle.trim());
    if (parts.postingCompany?.trim()) segments.push(parts.postingCompany.trim());
    if (segments.length === 0) return null;
    return `${segments.join(", ")} Resume`;
}

// "Salvador Salcedo - Software Engineer Intern - Rocket Lab Resume.pdf"
// Falls back to "resume-<dateSlug>.<ext>" when no parts are present —
// historical rows pre-dating any of these fields still get a sensible
// download name.
export function buildResumeDownloadFilename(
    parts: ResumeLabelParts & { format: string },
    fallbackDateSlug?: string,
): string {
    const segments: string[] = [];
    if (parts.userDisplayName?.trim()) segments.push(sanitizeFilenameSegment(parts.userDisplayName));
    if (parts.postingTitle?.trim()) segments.push(sanitizeFilenameSegment(parts.postingTitle));
    if (parts.postingCompany?.trim()) segments.push(sanitizeFilenameSegment(parts.postingCompany));
    const base = segments.filter(Boolean).length > 0
        ? `${segments.filter(Boolean).join(" - ")} Resume`
        : `resume-${fallbackDateSlug ?? new Date().toISOString().slice(0, 10)}`;
    return `${base}.${parts.format}`;
}
