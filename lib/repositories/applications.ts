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
    lastEmailMsgId?: string | null;
    lastUpdateAt?: Date;
}

export interface ApplicationUpdate {
    status?: string;
    kind?: string | null;
    nextSteps?: string | null;
    role?: string | null;
    lastEmailMsgId?: string | null;
    lastUpdateAt?: Date;
}

export function findApplicationsByUser(userId: string): Promise<Application[]> {
    return prisma.application.findMany({
        where: { userId },
        orderBy: { lastUpdateAt: 'desc' },
    });
}

export function findApplicationByCompany(
    userId: string,
    companyContains: string
): Promise<Application | null> {
    return prisma.application.findFirst({
        where: { userId, company: { contains: companyContains } },
    });
}

export function createApplication(data: ApplicationCreate): Promise<Application> {
    return prisma.application.create({ data });
}

export function updateApplication(id: string, data: ApplicationUpdate): Promise<Application> {
    return prisma.application.update({ where: { id }, data });
}
