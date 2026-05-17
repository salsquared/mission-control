import { prisma } from '@/lib/prisma';
import type { Application } from '@prisma/client';

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
    // PB-7 (was RAH-8): case-insensitive exact match. Previously this used `contains`,
    // which let a short LLM-classified company like "AI" match any prior row
    // whose name contained "ai" (e.g. "Sail-AI") and silently update the
    // wrong app's status — and let "Acme Co" vs "Acme Corp" create duplicates
    // by being one-directional. Exact equality on the normalized company name
    // is what we actually want for the dedup identity.
    //
    // Prisma's `mode: "insensitive"` is PostgreSQL/MongoDB-only — SQLite
    // doesn't support it. Use $queryRaw with LOWER() for portable case-fold
    // equality. Bounded LIMIT 1 + parameterized values (no string concat) keep
    // the query safe and well-indexed (userId is indexed; LOWER(company)
    // forces a scan within that user's rows, which is fine at the dozens-of-
    // applications scale).
    const rows = await prisma.$queryRaw<Application[]>`
        SELECT * FROM "Application"
        WHERE "userId" = ${userId} AND LOWER("company") = LOWER(${company})
        LIMIT 1
    `;
    return rows[0] ?? null;
}

export function createApplication(data: ApplicationCreate): Promise<Application> {
    return prisma.application.create({ data });
}

export function updateApplication(id: string, data: ApplicationUpdate): Promise<Application> {
    return prisma.application.update({ where: { id }, data });
}

export function deleteApplication(id: string): Promise<Application> {
    return prisma.application.delete({ where: { id } });
}
