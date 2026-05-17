import { prisma } from '@/lib/prisma';
import type { Application } from '@prisma/client';
import { normalizeCompanyName } from '@/lib/applications/normalize-company';

export interface ApplicationCreate {
    userId: string;
    company: string;
    role: string;
    status: string;
    kind?: string | null;
    nextSteps?: string | null;
    dateApplied?: Date;
    decisionDeadline?: Date;
    lastEmailMsgId?: string | null;
    postingId?: string | null;
    lastUpdateAt?: Date;
    /** PA-3: optional explicit normalized key. When omitted, derived from `company`. */
    normalizedCompany?: string;
}

export interface ApplicationUpdate {
    status?: string;
    kind?: string | null;
    nextSteps?: string | null;
    role?: string | null;
    company?: string;
    dateApplied?: Date | null;
    decisionDeadline?: Date | null;
    lastEmailMsgId?: string | null;
    lastUpdateAt?: Date;
}

export function findApplicationsByUser(userId: string): Promise<Application[]> {
    return prisma.application.findMany({
        where: { userId },
        orderBy: { lastUpdateAt: 'desc' },
    });
}

export function findApplicationByIdForUser(id: string, userId: string): Promise<Application | null> {
    return prisma.application.findFirst({ where: { id, userId } });
}

export async function findApplicationByCompany(
    userId: string,
    company: string
): Promise<Application | null> {
    // PA-3: prefer the indexed `normalizedCompany` lookup when present, falling
    // back to the legacy LOWER(company) raw query for rows that haven't been
    // backfilled yet (and as a safety net if normalization itself drifts).
    const key = normalizeCompanyName(company);
    if (key) {
        const row = await prisma.application.findFirst({
            where: { userId, normalizedCompany: key },
        });
        if (row) return row;
    }
    // Fallback for legacy rows where normalizedCompany is still null. PB-7
    // (was RAH-8): case-insensitive exact match — Prisma's `mode:"insensitive"`
    // is PostgreSQL/MongoDB-only, so we use $queryRaw with LOWER() for SQLite.
    const rows = await prisma.$queryRaw<Application[]>`
        SELECT * FROM "Application"
        WHERE "userId" = ${userId} AND LOWER("company") = LOWER(${company})
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
