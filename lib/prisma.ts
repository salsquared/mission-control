import { PrismaClient } from '@prisma/client';

const globalForPrisma = global as unknown as { prisma: PrismaClient };

// Delete local cache temporarily to force recreation
delete (globalForPrisma as any).prisma;

const basePrisma = globalForPrisma.prisma || new PrismaClient();

// SQLite write-concurrency pragmas. WAL is persistent in the file header so
// it sticks across all future connections; busy_timeout and synchronous are
// per-connection. Mission-control is now multi-writer (web tier + scheduler
// process), so this is required to avoid SQLITE_BUSY contention. Errors are
// swallowed because the pragmas may already be applied.
basePrisma.$executeRawUnsafe('PRAGMA journal_mode = WAL').catch(() => {});
basePrisma.$executeRawUnsafe('PRAGMA busy_timeout = 5000').catch(() => {});
basePrisma.$executeRawUnsafe('PRAGMA synchronous = NORMAL').catch(() => {});

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
