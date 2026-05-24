/**
 * M7.6.4 — Archive retrieval helper.
 *
 * Pure function. No DB / no I/O / no async. Given pre-fetched `ResumeUpload`
 * rows (the caller is responsible for the Prisma query — typically the most
 * recent N uploads for a user) and a "parent" we're filling/polishing bullets
 * for, return up to 3 text spans drawn from the uploads' rawText that mention
 * the parent's identifier. Each span is a ±500-char window around the first
 * case-insensitive occurrence of the identifier inside that upload.
 *
 * Spans feed an LLM prompt as grounding evidence so the model has access to
 * the user's historical wording for the same employer / project / school —
 * which the live `Profile.*` row may have lost via dedup during M7.4 import.
 *
 * Contract:
 *   - At most one span per upload (the first match wins).
 *   - Ranking: `uploadedAt` DESC (newest first). Equal timestamps preserve
 *     input order — `.sort` in modern V8 is stable, and that's the documented
 *     fallback.
 *   - Capped at 3 spans total via `.slice(0, 3)`.
 *   - Returned `span.length <= identifier.length + 1000` always (the window
 *     is ±500 chars, so worst case is identifier in the middle with both
 *     sides hitting their cap).
 *   - Returns `[]` for null / empty / whitespace-only identifiers and for
 *     uploads whose rawText is null / empty / undefined.
 */

import type { ResumeUpload } from '@prisma/client';

export interface ArchiveSpan {
    uploadId: string;
    uploadedAt: Date;
    filename: string;
    span: string;
}

export interface ArchiveParent {
    kind: 'work-role' | 'project' | 'education';
    // Resolved identifier: company for work-role, name for project, institution for education.
    // If null / empty / whitespace, the function returns [].
    identifier: string | null;
}

const WINDOW_RADIUS = 500;
const MAX_SPANS = 3;

export function findArchiveSpansFor(
    parent: ArchiveParent,
    uploads: ResumeUpload[],
): ArchiveSpan[] {
    if (parent.identifier == null) return [];
    const needle = parent.identifier.trim();
    if (needle.length === 0) return [];

    const needleLower = needle.toLowerCase();
    const spans: ArchiveSpan[] = [];

    for (const upload of uploads) {
        const raw = upload.rawText;
        if (raw == null || raw.length === 0) continue;

        const idx = raw.toLowerCase().indexOf(needleLower);
        if (idx === -1) continue;

        const start = Math.max(0, idx - WINDOW_RADIUS);
        const end = Math.min(raw.length, idx + needle.length + WINDOW_RADIUS);
        const span = raw.slice(start, end);

        spans.push({
            uploadId: upload.id,
            uploadedAt: upload.uploadedAt,
            filename: upload.filename,
            span,
        });
    }

    // Newest-first by uploadedAt. Array.prototype.sort is stable in V8/Node,
    // so equal timestamps preserve input order.
    spans.sort((a, b) => b.uploadedAt.getTime() - a.uploadedAt.getTime());

    return spans.slice(0, MAX_SPANS);
}
