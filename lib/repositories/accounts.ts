import { prisma } from '@/lib/prisma';
import type { Account } from '@prisma/client';

export function findGoogleAccountByUser(userId: string): Promise<Account | null> {
    return prisma.account.findFirst({
        where: { userId, provider: 'google' },
    });
}
