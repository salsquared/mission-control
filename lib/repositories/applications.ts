import { prisma } from '@/lib/prisma';
import type { Application } from '@prisma/client';
import { normalizeCompanyName } from '@/lib/applications/normalize-company';

export interface ApplicationCreate {
    userId: string;
    company: string;
    role: string;
    status: string;
    kind?: string | null;
    /** MB Phase 4: "career" | "side". Defaults to "career" when omitted. */
    track?: string;
    nextSteps?: string | null;
    dateApplied?: Date;
    decisionDeadline?: Date;
    lastEmailMsgId?: string | null;
    postingId?: string | null;
    lastUpdateAt?: Date;
    /** PA-3: optional explicit normalized key. When omitted, derived from `company`. */
    normalizedCompany?: string;
    /** Layered-dedup fallback (2026-05-20). See Application.senderDomain. */
    senderDomain?: string | null;
}

export interface ApplicationUpdate {
    status?: string;
    kind?: string | null;
    track?: string;
    nextSteps?: string | null;
    role?: string | null;
    company?: string;
    dateApplied?: Date | null;
    decisionDeadline?: Date | null;
    lastEmailMsgId?: string | null;
    lastUpdateAt?: Date;
    senderDomain?: string | null;
}

/**
 * MB Phase 4: optional track filter. When omitted, returns rows from every
 * track (used by Gmail/Gcal sync paths that don't care about pipeline). The
 * Applications API GET passes the track from the ?track= query string so the
 * two kanbans on ApplicationsView each get a track-scoped list.
 */
export function findApplicationsByUser(userId: string, track?: string): Promise<Application[]> {
    return prisma.application.findMany({
        where: track ? { userId, track } : { userId },
        orderBy: { lastUpdateAt: 'desc' },
    });
}

export function findApplicationByIdForUser(id: string, userId: string): Promise<Application | null> {
    return prisma.application.findFirst({ where: { id, userId } });
}

/**
 * Layered-dedup fallback (2026-05-20). Look up an existing Application by the
 * sender domain stamped on prior ingests. Used by ingest.ts only AFTER
 * `findApplicationByCompany` returns null — the LLM classifier drifted on the
 * company name (e.g. Cal State Long Beach / CSULB / California State
 * University Long Beach all referring to the same school).
 *
 * Caller is responsible for blocklisting multi-tenant ATS roots
 * (extractSenderDomain returns null for those, so this never gets called
 * with `greenhouse.io` / `commonapp.org` / etc.).
 *
 * MB Phase 4: scoped by track. Gmail ingest always passes "career" — the
 * companion track-as-application route passes the parent watchlist's track.
 * Two tracks for the same domain coexist (e.g. "starbucks.com" career vs
 * side); the dedup hit stays within the caller's pipeline.
 */
export function findApplicationBySenderDomain(
    userId: string,
    senderDomain: string,
    track: string,
): Promise<Application | null> {
    return prisma.application.findFirst({
        where: { userId, senderDomain, track },
        orderBy: { lastUpdateAt: "desc" },
    });
}

export async function findApplicationByCompany(
    userId: string,
    company: string,
    track: string,
): Promise<Application | null> {
    // PA-3: prefer the indexed `normalizedCompany` lookup when present, falling
    // back to the legacy LOWER(company) raw query for rows that haven't been
    // backfilled yet (and as a safety net if normalization itself drifts).
    // MB Phase 4: both paths scope by track so e.g. Starbucks-barista (side)
    // and Starbucks-corporate (career) coexist without false dedup hits.
    const key = normalizeCompanyName(company);
    if (key) {
        const row = await prisma.application.findFirst({
            where: { userId, normalizedCompany: key, track },
        });
        if (row) return row;
    }
    // Fallback for legacy rows where normalizedCompany is still null. PB-7
    // (was RAH-8): case-insensitive exact match — Prisma's `mode:"insensitive"`
    // is PostgreSQL/MongoDB-only, so we use $queryRaw with LOWER() for SQLite.
    const rows = await prisma.$queryRaw<Application[]>`
        SELECT * FROM "Application"
        WHERE "userId" = ${userId}
          AND LOWER("company") = LOWER(${company})
          AND "track" = ${track}
        LIMIT 1
    `;
    return rows[0] ?? null;
}

export function createApplication(data: ApplicationCreate): Promise<Application> {
    // PA-3: persist the normalized key alongside the raw company so future
    // lookups hit the @@unique([userId, normalizedCompany]) index.
    return prisma.application.create({
        data: {
            ...data,
            normalizedCompany: data.normalizedCompany ?? normalizeCompanyName(data.company),
        },
    });
}

export function updateApplication(id: string, data: ApplicationUpdate): Promise<Application> {
    // PA-3: if the caller is renaming `company`, keep `normalizedCompany` in
    // sync so the @@unique index doesn't get out of step with the displayed
    // name. Other updates pass through unchanged.
    const sync: Partial<Pick<Application, "normalizedCompany">> = {};
    if (data.company !== undefined) sync.normalizedCompany = normalizeCompanyName(data.company);
    return prisma.application.update({ where: { id }, data: { ...data, ...sync } });
}

export function deleteApplication(id: string): Promise<Application> {
    return prisma.application.delete({ where: { id } });
}

// Story S13.8 — bulk track move. The schema's
// @@unique([userId, normalizedCompany, track]) means moving a row to a track
// where the same normalizedCompany already exists throws P2002. We pre-check
// in the same transaction so the response can carry the conflicting pairs
// and the UI can ask the user to resolve them (delete one, edit the other,
// or leave both) instead of seeing an opaque 500.
export interface BulkTrackConflict {
    id: string;                       // the id being moved
    normalizedCompany: string | null; // the key that would collide
    company: string;                  // displayable
    existingId: string;               // the existing row already in target track
}

export interface BulkTrackResult {
    updated: number;
    ids: string[];
    conflicts: BulkTrackConflict[];
}

export async function bulkMoveApplicationsTrack(
    userId: string,
    ids: string[],
    targetTrack: string,
): Promise<BulkTrackResult> {
    return prisma.$transaction(async (tx) => {
        // 1. Fetch the rows we're being asked to move — ownership-scope by userId
        //    so cross-user ids silently drop.
        const candidates = await tx.application.findMany({
            where: { id: { in: ids }, userId },
            select: { id: true, normalizedCompany: true, company: true, track: true },
        });

        // Rows already on the target track are no-ops (don't count toward updated,
        // don't risk a P2002).
        const toMove = candidates.filter(c => c.track !== targetTrack);
        if (toMove.length === 0) {
            return { updated: 0, ids: candidates.map(c => c.id), conflicts: [] };
        }

        // 2. Find existing rows in the target track that would collide on
        //    normalizedCompany. Rows with null normalizedCompany can't collide
        //    (SQLite allows multiple NULLs in the compound unique).
        const keys = toMove
            .map(c => c.normalizedCompany)
            .filter((k): k is string => typeof k === 'string' && k.length > 0);
        const conflicts: BulkTrackConflict[] = [];
        if (keys.length > 0) {
            const existing = await tx.application.findMany({
                where: {
                    userId,
                    track: targetTrack,
                    normalizedCompany: { in: keys },
                    // Exclude self — if the user somehow ends up trying to "move" to
                    // its own track, we already filtered those out, but defense in
                    // depth in case toMove has overlap with target somehow.
                    NOT: { id: { in: ids } },
                },
                select: { id: true, normalizedCompany: true },
            });
            const existingByKey = new Map<string, string>();
            for (const e of existing) {
                if (e.normalizedCompany) existingByKey.set(e.normalizedCompany, e.id);
            }
            for (const m of toMove) {
                if (m.normalizedCompany && existingByKey.has(m.normalizedCompany)) {
                    conflicts.push({
                        id: m.id,
                        normalizedCompany: m.normalizedCompany,
                        company: m.company,
                        existingId: existingByKey.get(m.normalizedCompany)!,
                    });
                }
            }
        }

        if (conflicts.length > 0) {
            // Don't move anything if any row would conflict — partial state is
            // hard to reason about and the conflicts UI is the place to resolve.
            return { updated: 0, ids: [], conflicts };
        }

        const moveIds = toMove.map(c => c.id);
        await tx.application.updateMany({
            where: { id: { in: moveIds }, userId },
            data: { track: targetTrack },
        });
        return { updated: moveIds.length, ids: moveIds, conflicts: [] };
    });
}
