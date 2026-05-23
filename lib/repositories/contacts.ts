import { prisma } from '@/lib/prisma';
import type { Contact } from '@prisma/client';

// Story 50 — Contact CRUD. Every read/write checks ownership through the
// parent Application's userId so cross-user access can't slip through even
// with a forged applicationId.

export interface ContactCreateInput {
    applicationId: string;
    name: string;
    email?: string | null;
    role?: string | null;
    notes?: string | null;
    lastTouchedAt?: Date | null;
    position?: number;
}

export interface ContactUpdateInput {
    name?: string;
    email?: string | null;
    role?: string | null;
    notes?: string | null;
    lastTouchedAt?: Date | null;
    position?: number;
}

async function nextContactPosition(applicationId: string): Promise<number> {
    const agg = await prisma.contact.aggregate({
        where: { applicationId },
        _max: { position: true },
    });
    return (agg._max.position ?? 0) + 1;
}

// Returns the application's userId iff the user owns it, else null. Cheaper
// than a full fetch + check pattern repeated at every callsite.
async function applicationOwner(userId: string, applicationId: string): Promise<string | null> {
    const row = await prisma.application.findFirst({
        where: { id: applicationId, userId },
        select: { userId: true },
    });
    return row ? row.userId : null;
}

export async function listContactsForApplication(
    userId: string,
    applicationId: string,
): Promise<Contact[]> {
    if (!(await applicationOwner(userId, applicationId))) return [];
    return prisma.contact.findMany({
        where: { applicationId },
        orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    });
}

export async function createContact(
    userId: string,
    input: ContactCreateInput,
): Promise<Contact | null> {
    if (!(await applicationOwner(userId, input.applicationId))) return null;
    const position = input.position ?? await nextContactPosition(input.applicationId);
    return prisma.contact.create({
        data: {
            applicationId: input.applicationId,
            name: input.name,
            email: input.email ?? null,
            role: input.role ?? null,
            notes: input.notes ?? null,
            lastTouchedAt: input.lastTouchedAt ?? null,
            position,
        },
    });
}

export async function updateContact(
    userId: string,
    id: string,
    input: ContactUpdateInput,
): Promise<Contact | null> {
    // Ownership check via the application join — single round-trip.
    const existing = await prisma.contact.findFirst({
        where: { id, application: { userId } },
        select: { id: true },
    });
    if (!existing) return null;

    const payload: Record<string, unknown> = {};
    if (input.name !== undefined) payload.name = input.name;
    if (input.email !== undefined) payload.email = input.email;
    if (input.role !== undefined) payload.role = input.role;
    if (input.notes !== undefined) payload.notes = input.notes;
    if (input.lastTouchedAt !== undefined) payload.lastTouchedAt = input.lastTouchedAt;
    if (input.position !== undefined) payload.position = input.position;

    return prisma.contact.update({ where: { id }, data: payload });
}

export async function deleteContact(userId: string, id: string): Promise<boolean> {
    const existing = await prisma.contact.findFirst({
        where: { id, application: { userId } },
        select: { id: true },
    });
    if (!existing) return false;
    await prisma.contact.delete({ where: { id } });
    return true;
}

// Picks the "primary" contact for an application — the one the follow-up
// nudge body should address. Order of preference:
//   1. Most recently touched (lastTouchedAt desc)
//   2. Lowest position (kanban-style first-row preference)
//   3. Earliest created
// Returns null if the application has no contacts.
export async function primaryContactForApplication(
    applicationId: string,
): Promise<Contact | null> {
    const row = await prisma.contact.findFirst({
        where: { applicationId },
        orderBy: [
            { lastTouchedAt: { sort: 'desc', nulls: 'last' } },
            { position: 'asc' },
            { createdAt: 'asc' },
        ],
    });
    return row;
}
