import { prisma } from '@/lib/prisma';
import type { Application, ApplicationEmail } from '@prisma/client';

export interface ApplicationCreate {
    userId: string;
    company: string;
    role: string;
    status: string;
    nextSteps?: string | null;
    nextStepAt?: Date | null;
    dateApplied?: Date;
    lastUpdateAt?: Date;
}

export interface ApplicationUpdate {
    status?: string;
    nextSteps?: string | null;
    nextStepAt?: Date | null;
    role?: string | null;
    lastUpdateAt?: Date;
}

export interface ApplicationEmailCreate {
    applicationId: string;
    messageId: string;
    threadId?: string | null;
    subject: string;
    fromAddress: string;
    receivedAt: Date;
    snippet?: string | null;
    parsedStatus?: string | null;
}

export type ApplicationWithEmails = Application & { emails: ApplicationEmail[] };

const RECENT_EMAILS_PER_APP = 5;

export function findApplicationsByUser(userId: string): Promise<ApplicationWithEmails[]> {
    return prisma.application.findMany({
        where: { userId },
        orderBy: { lastUpdateAt: 'desc' },
        include: {
            emails: {
                orderBy: { receivedAt: 'desc' },
                take: RECENT_EMAILS_PER_APP,
            },
        },
    });
}

export function findApplicationByCompany(
    userId: string,
    companyContains: string
): Promise<Application | null> {
    return prisma.application.findFirst({
        where: { userId, company: { contains: normalizeCompany(companyContains) } },
    });
}

export function createApplication(data: ApplicationCreate): Promise<Application> {
    return prisma.application.create({ data });
}

export function updateApplication(id: string, data: ApplicationUpdate): Promise<Application> {
    return prisma.application.update({ where: { id }, data });
}

export async function createApplicationEmailIfNew(
    data: ApplicationEmailCreate
): Promise<ApplicationEmail | null> {
    // messageId is unique — duplicate Pub/Sub deliveries should be no-ops.
    const existing = await prisma.applicationEmail.findUnique({
        where: { messageId: data.messageId },
    });
    if (existing) return null;
    return prisma.applicationEmail.create({ data });
}

// Lowercase, strip punctuation, collapse whitespace, drop common corporate
// suffixes so "Stripe, Inc." matches "Stripe".
function normalizeCompany(raw: string): string {
    return raw
        .toLowerCase()
        .replace(/[.,]/g, ' ')
        .replace(/\b(inc|llc|corp|corporation|co|ltd|limited|gmbh)\b/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}
