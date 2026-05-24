import { prisma } from '@/lib/prisma';

// M7.6.3 — repository helpers for the ResumeUpload archive table. See
// `docs/implementation.md` §M7.6 and the schema comment on `model ResumeUpload`
// for the broader story (append-only raw + parsed snapshot of every imported
// resume, so later features can reach back into prior versions).
//
// Conventions:
//  * Every read is owner-scoped (userId is a required arg). Mismatch → null /
//    empty, never throw — matches the profile-snapshots repo.
//  * `listResumeUploads` is a deliberately narrow projection. rawText +
//    parsedJson are each capped at 200 KB; pulling them on a "list" call would
//    fan out tens of MB for power users. Callers that need the heavy payload
//    must take the explicit `getResumeUpload` path.
//  * `findUploadsMatchingParent` uses $queryRaw + LOWER(...) because Prisma's
//    `mode: 'insensitive'` filter is PostgreSQL/MongoDB-only and we run on
//    SQLite. Same pattern as `findApplicationByCompany` in applications.ts.

export interface ResumeUploadSummary {
    id: string;
    userId: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    artifactPath: string | null;
    importBatchId: string | null;
    uploadedAt: Date;
}

export interface ResumeUploadFull extends ResumeUploadSummary {
    rawText: string;
    parsedJson: string;
}

export interface ArchiveParentRef {
    kind: 'work-role' | 'project' | 'education';
    company?: string | null;       // work-role
    name?: string | null;          // project
    institution?: string | null;   // education
}

// Newest-first summary projection. Excludes the two heavy columns (rawText +
// parsedJson) so a list call stays small even on accounts with dozens of
// uploads.
export async function listResumeUploads(userId: string): Promise<ResumeUploadSummary[]> {
    const rows = await prisma.resumeUpload.findMany({
        where: { userId },
        select: {
            id: true,
            userId: true,
            filename: true,
            mimeType: true,
            sizeBytes: true,
            artifactPath: true,
            importBatchId: true,
            uploadedAt: true,
        },
        orderBy: { uploadedAt: 'desc' },
    });
    return rows;
}

// Full row including rawText + parsedJson. Owner check: returns null if id
// doesn't exist OR belongs to a different user. Never throws on missing.
export async function getResumeUpload(
    uploadId: string,
    userId: string,
): Promise<ResumeUploadFull | null> {
    const row = await prisma.resumeUpload.findFirst({
        where: { id: uploadId, userId },
    });
    if (!row) return null;
    return {
        id: row.id,
        userId: row.userId,
        filename: row.filename,
        mimeType: row.mimeType,
        sizeBytes: row.sizeBytes,
        artifactPath: row.artifactPath,
        importBatchId: row.importBatchId,
        uploadedAt: row.uploadedAt,
        rawText: row.rawText,
        parsedJson: row.parsedJson,
    };
}

function resolveParentIdentifier(parent: ArchiveParentRef): string | null {
    let raw: string | null | undefined;
    switch (parent.kind) {
        case 'work-role':
            raw = parent.company;
            break;
        case 'project':
            raw = parent.name;
            break;
        case 'education':
            raw = parent.institution;
            break;
    }
    if (raw === null || raw === undefined) return null;
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
}

// Returns up to `limit` (default 5) full ResumeUpload rows for this user where
// rawText contains the parent's identifier (case-insensitive). Newest-first
// by uploadedAt. Returns [] when the identifier resolves to null / empty /
// whitespace, so callers can pass parents straight through without
// pre-validating.
export async function findUploadsMatchingParent(
    userId: string,
    parent: ArchiveParentRef,
    limit = 5,
): Promise<ResumeUploadFull[]> {
    const identifier = resolveParentIdentifier(parent);
    if (!identifier) return [];

    // SQLite needs LOWER() for case-insensitive matching — Prisma's
    // `mode: 'insensitive'` is PG/Mongo-only. See `findApplicationByCompany`
    // in applications.ts for the same pattern.
    type RawRow = {
        id: string;
        userId: string;
        filename: string;
        mimeType: string;
        sizeBytes: number | bigint;
        rawText: string;
        parsedJson: string;
        artifactPath: string | null;
        importBatchId: string | null;
        uploadedAt: Date | string;
    };
    const like = `%${identifier}%`;
    const rows = await prisma.$queryRaw<RawRow[]>`
        SELECT id, "userId", filename, "mimeType", "sizeBytes", "rawText", "parsedJson", "artifactPath", "importBatchId", "uploadedAt"
        FROM "ResumeUpload"
        WHERE "userId" = ${userId}
          AND LOWER("rawText") LIKE LOWER(${like})
        ORDER BY "uploadedAt" DESC
        LIMIT ${limit}
    `;

    // $queryRaw returns raw driver types — Date may arrive as an ISO string,
    // numeric columns may arrive as bigint depending on the driver. Coerce
    // both so callers get the same shape they would from a normal Prisma
    // findMany.
    return rows.map((row) => ({
        id: row.id,
        userId: row.userId,
        filename: row.filename,
        mimeType: row.mimeType,
        sizeBytes: Number(row.sizeBytes),
        artifactPath: row.artifactPath,
        importBatchId: row.importBatchId,
        uploadedAt: row.uploadedAt instanceof Date ? row.uploadedAt : new Date(row.uploadedAt),
        rawText: row.rawText,
        parsedJson: row.parsedJson,
    }));
}

// Owner-checked delete of the DB row. Returns true if deleted, false if id
// doesn't exist or belongs to another user. Uses deleteMany so a 0-row result
// surfaces naturally as `count === 0` instead of throwing P2025.
//
// TODO M7.6.3-followup: also unlink artifactPath via
// lib/profile/storage.ts:deleteResumeUpload once that lands (M7.6.2).
export async function deleteResumeUpload(
    uploadId: string,
    userId: string,
): Promise<boolean> {
    const result = await prisma.resumeUpload.deleteMany({
        where: { id: uploadId, userId },
    });
    return result.count > 0;
}
