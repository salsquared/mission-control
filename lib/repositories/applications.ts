import { prisma } from '@/lib/prisma';
import type { Application, JobPosting } from '@prisma/client';
import { normalizeCompanyName } from '@/lib/applications/normalize-company';
import { normalizeRoleName } from '@/lib/applications/normalize-role';

export interface ApplicationCreate {
    userId: string;
    company: string;
    role: string;
    status: string;
    kind?: string | null;
    /**
     * MB Phase 4: "career" | "side". REQUIRED — no fallback. The previous
     * `?? "career"` default let ingest write career rows without making the
     * track decision visible at the call site, which masked the cross-track
     * dedup bug (a side-track row already existed for the same company; ingest
     * was scoped to "career" and never saw it). Every create site now states
     * its track explicitly so a future audit is `grep "createApplication("`.
     */
    track: string;
    nextSteps?: string | null;
    dateApplied?: Date;
    decisionDeadline?: Date;
    lastEmailMsgId?: string | null;
    postingId?: string | null;
    lastUpdateAt?: Date;
    /** PA-3: optional explicit normalized key. When omitted, derived from `company`. */
    normalizedCompany?: string;
    /** 2026-05-27: optional explicit normalized role key. When omitted, derived from `role`. */
    normalizedRole?: string;
    /** 2026-05-27: ATS-stable job identifier (posting.externalId) for track-as-application dedup. */
    sourceJobId?: string | null;
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
    sourceJobId?: string | null;
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

// M8.4.4 (story S8.12) — Pipeline picker source. Returns the user's
// INTERESTED-status applications that have a linked JobPosting with a non-null
// `sourceUrl`. The picker UI lists these as the auto-fill source for the resume
// generate flow. Manual-add Apps (S2.3) and cold-email Apps (S1.1) lack a
// linked JobPosting → naturally excluded by the `NOT: { postingId: null }`
// filter. We post-filter on `posting?.sourceUrl != null` defensively — the
// schema doesn't strictly require sourceUrl, so a malformed posting row
// (legacy / hand-edited) wouldn't be picker-eligible even though it has a
// postingId. Per Decision 6.4, URL-less Interested apps are hidden from the
// picker; the URL or Paste segmented-control tabs are the fallback.
export type InterestedWithPostingRow = Application & {
    posting: Pick<JobPosting, "sourceUrl" | "title"> | null;
};

export function findInterestedWithPostingForUser(
    userId: string,
): Promise<InterestedWithPostingRow[]> {
    return prisma.application.findMany({
        where: {
            userId,
            status: 'INTERESTED',
            NOT: { postingId: null },
        },
        include: {
            posting: { select: { sourceUrl: true, title: true } },
        },
        orderBy: { lastUpdateAt: 'desc' },
    });
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
 * MB Phase 4 (2026-05-27): `track` is optional. When omitted, lookup is
 * track-agnostic — used by Gmail ingest's cross-track dedup so a manually-
 * created side-track row is found and updated instead of duplicated on
 * career. When supplied, scopes to a single track (used by the track-as-
 * application path, which knows the watchlist's track upfront).
 *
 * Returns the most recently updated match; the caller is responsible for any
 * cross-track tie-breaker logic (e.g. preferring a senderDomain-stamped row).
 */
export function findApplicationBySenderDomain(
    userId: string,
    senderDomain: string,
    track?: string,
): Promise<Application | null> {
    return prisma.application.findFirst({
        where: track ? { userId, senderDomain, track } : { userId, senderDomain },
        orderBy: { lastUpdateAt: "desc" },
    });
}

export async function findApplicationByCompany(
    userId: string,
    company: string,
    track?: string,
): Promise<Application | null> {
    // PA-3: prefer the indexed `normalizedCompany` lookup when present, falling
    // back to the legacy LOWER(company) raw query for rows that haven't been
    // backfilled yet (and as a safety net if normalization itself drifts).
    // MB Phase 4 (2026-05-27): `track` is optional. When omitted, both halves
    // of the lookup are track-agnostic so ingest finds a manual side-track row
    // before defaulting a new email to career.
    const key = normalizeCompanyName(company);
    if (key) {
        const row = await prisma.application.findFirst({
            where: track
                ? { userId, normalizedCompany: key, track }
                : { userId, normalizedCompany: key },
            orderBy: { lastUpdateAt: "desc" },
        });
        if (row) return row;
    }
    // Fallback for legacy rows where normalizedCompany is still null. PB-7
    // (was RAH-8): case-insensitive exact match — Prisma's `mode:"insensitive"`
    // is PostgreSQL/MongoDB-only, so we use $queryRaw with LOWER() for SQLite.
    const rows = track
        ? await prisma.$queryRaw<Application[]>`
            SELECT * FROM "Application"
            WHERE "userId" = ${userId}
              AND LOWER("company") = LOWER(${company})
              AND "track" = ${track}
            ORDER BY "lastUpdateAt" DESC
            LIMIT 1
        `
        : await prisma.$queryRaw<Application[]>`
            SELECT * FROM "Application"
            WHERE "userId" = ${userId}
              AND LOWER("company") = LOWER(${company})
            ORDER BY "lastUpdateAt" DESC
            LIMIT 1
        `;
    return rows[0] ?? null;
}

export function createApplication(data: ApplicationCreate): Promise<Application> {
    // PA-3 + 2026-05-27: persist BOTH normalized keys alongside the raw
    // company/role so future lookups hit the
    // @@unique([userId, normalizedCompany, normalizedRole, track]) index.
    // `track` is required on the input type — no default. See ApplicationCreate.
    return prisma.application.create({
        data: {
            ...data,
            normalizedCompany: data.normalizedCompany ?? normalizeCompanyName(data.company),
            normalizedRole: data.normalizedRole ?? normalizeRoleName(data.role),
        },
    });
}

export function updateApplication(id: string, data: ApplicationUpdate): Promise<Application> {
    // PA-3 + 2026-05-27: if the caller is renaming `company` or `role`, keep
    // the matching normalized columns in sync so the @@unique index doesn't
    // get out of step with the displayed name. Other updates pass through
    // unchanged. role is nullable on the model (legacy "Unknown" defaults),
    // so a null role normalizes to "" — leave the existing normalizedRole
    // alone in that case instead of poisoning the key.
    const sync: Partial<Pick<Application, "normalizedCompany" | "normalizedRole">> = {};
    if (data.company !== undefined) sync.normalizedCompany = normalizeCompanyName(data.company);
    if (data.role !== undefined && data.role !== null) {
        const key = normalizeRoleName(data.role);
        if (key) sync.normalizedRole = key;
    }
    return prisma.application.update({ where: { id }, data: { ...data, ...sync } });
}

/**
 * 2026-05-27 multi-role-per-company. Layered-dedup primary lookup. Returns
 * the most-recently-updated row whose (normalizedCompany, normalizedRole)
 * matches the given (company, role) — optionally scoped to a track. When
 * track is omitted, the lookup spans both kanbans (used by Gmail ingest
 * cross-track dedup so a manually-created side-track row gets found and
 * updated instead of duplicated on career).
 *
 * Falls back to LOWER(company) LIKE-style match only when normalizedRole
 * yields no result — that path is intentionally not present here because
 * the previous PB-7 legacy LOWER() fallback covered NULL-normalizedCompany
 * rows and we want the new role key to be strict: a NULL normalizedRole
 * means "this row hasn't been backfilled yet" — let it fall through to
 * the senderDomain fallback rather than guess.
 */
export async function findApplicationByCompanyAndRole(
    userId: string,
    company: string,
    role: string,
    track?: string,
): Promise<Application | null> {
    const companyKey = normalizeCompanyName(company);
    const roleKey = normalizeRoleName(role);
    if (!companyKey || !roleKey) return null;
    return prisma.application.findFirst({
        where: track
            ? { userId, normalizedCompany: companyKey, normalizedRole: roleKey, track }
            : { userId, normalizedCompany: companyKey, normalizedRole: roleKey },
        orderBy: { lastUpdateAt: "desc" },
    });
}

/**
 * 2026-05-27 multi-role-per-company. ATS-stable job-id lookup used by
 * track-as-application BEFORE company+role match — if a user clicked Track
 * on the same LinkedIn job from two different watchlists, the second click
 * should merge into the first row instead of either creating a new app or
 * 500ing on the unique-key collision.
 *
 * sourceJobId alone isn't globally unique (Greenhouse req `12345` and
 * LinkedIn job `12345` could collide across employers), so the lookup is
 * always scoped to userId — and the operator-visible expectation is that
 * the caller has already verified company match via posting.externalId
 * provenance.
 */
export async function findApplicationBySourceJobId(
    userId: string,
    sourceJobId: string,
): Promise<Application | null> {
    if (!sourceJobId) return null;
    return prisma.application.findFirst({
        where: { userId, sourceJobId },
        orderBy: { lastUpdateAt: "desc" },
    });
}

export function deleteApplication(id: string): Promise<Application> {
    return prisma.application.delete({ where: { id } });
}

// Story S13.8 — bulk track move. The schema's
// @@unique([userId, normalizedCompany, normalizedRole, track]) (2026-05-27)
// means moving a row to a track where the same (company, role) pair already
// exists throws P2002. We pre-check in the same transaction so the response
// can carry the conflicting pairs and the UI can ask the user to resolve them
// (delete one, edit the other, or leave both) instead of seeing an opaque 500.
//
// Compared to the pre-2026-05-27 company-only unique, the same-company /
// different-role move now succeeds (e.g. moving "Allied Universal — Security
// Officer Museum Rover" to a track that already has "Allied Universal —
// Mall Patrol" is fine).
export interface BulkTrackConflict {
    id: string;                       // the id being moved
    normalizedCompany: string | null; // the key half that would collide
    normalizedRole: string | null;    // the other key half that would collide
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
            select: { id: true, normalizedCompany: true, normalizedRole: true, company: true, track: true },
        });

        // Rows already on the target track are no-ops (don't count toward updated,
        // don't risk a P2002).
        const toMove = candidates.filter(c => c.track !== targetTrack);
        if (toMove.length === 0) {
            return { updated: 0, ids: candidates.map(c => c.id), conflicts: [] };
        }

        // 2. Find existing rows in the target track that would collide on the
        //    new (normalizedCompany, normalizedRole) pair. Rows with NULL on
        //    either component can't collide (SQLite NULL-distinct in compound
        //    unique). Pulling on company first then post-filtering by role
        //    keeps the IN clause well under the 999-param ceiling for
        //    realistic bulk-move sizes.
        const companyKeys = toMove
            .map(c => c.normalizedCompany)
            .filter((k): k is string => typeof k === 'string' && k.length > 0);
        const conflicts: BulkTrackConflict[] = [];
        if (companyKeys.length > 0) {
            const existing = await tx.application.findMany({
                where: {
                    userId,
                    track: targetTrack,
                    normalizedCompany: { in: companyKeys },
                    // Exclude self — if the user somehow ends up trying to "move" to
                    // its own track, we already filtered those out, but defense in
                    // depth in case toMove has overlap with target somehow.
                    NOT: { id: { in: ids } },
                },
                select: { id: true, normalizedCompany: true, normalizedRole: true },
            });
            const existingByPair = new Map<string, string>();
            for (const e of existing) {
                if (e.normalizedCompany && e.normalizedRole) {
                    existingByPair.set(`${e.normalizedCompany} ${e.normalizedRole}`, e.id);
                }
            }
            for (const m of toMove) {
                if (!m.normalizedCompany || !m.normalizedRole) continue;
                const pair = `${m.normalizedCompany} ${m.normalizedRole}`;
                const existingId = existingByPair.get(pair);
                if (existingId) {
                    conflicts.push({
                        id: m.id,
                        normalizedCompany: m.normalizedCompany,
                        normalizedRole: m.normalizedRole,
                        company: m.company,
                        existingId,
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
