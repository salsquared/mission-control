import { prisma } from '@/lib/prisma';
import type { User, Account } from '@prisma/client';

export function findUserByEmail(email: string): Promise<User | null> {
    return prisma.user.findUnique({ where: { email } });
}

export function findUserByEmailWithAccounts(
    email: string
): Promise<(User & { accounts: Account[] }) | null> {
    return prisma.user.findUnique({
        where: { email },
        include: { accounts: true },
    });
}
