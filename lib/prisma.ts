import { PrismaClient } from '@prisma/client';

const globalForPrisma = global as unknown as { prisma: PrismaClient };

// Delete local cache temporarily to force recreation
delete (globalForPrisma as any).prisma;

const basePrisma = globalForPrisma.prisma || new PrismaClient();

export const prisma = basePrisma.$extends({
    query: {
        $allModels: {
            async $allOperations({ model, operation, args, query }) {
                console.info(`[DATABASE] Executing ${operation} on ${model}`);
                return query(args);
            },
        },
    },
}) as unknown as typeof basePrisma;

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
