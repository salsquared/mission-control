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

// Per-query [DATABASE] logging is muted in dev because every console.info
// fans out to the in-process ring buffer AND every /api/system/logs SSE
// subscriber — the Internal Systems dash then re-renders on each push. With
// dozens of queries per page load that pegs the dev process. Production
// keeps logging on (the in-app log viewer is the canonical observability
// surface per CLAUDE.md); set DEBUG_PRISMA=1 in dev when you need it back.
//
// Also muted in BOTH scheduler tiers (MC_SCHEDULER_TIER set) regardless of
// NODE_ENV: the prod scheduler runs NODE_ENV=production, so without this it
// would JSON-emit a [DATABASE] line per query into data/logs.db + the in-app
// viewer — thousands per sweep, drowning the scheduler's job summaries. The
// crawl signal lives in [EXTERNAL API] lines + the FetcherHealthCard instead.
// See docs/scheduler-structured-logs.html (OQ7).
const LOG_PRISMA_QUERIES =
    (process.env.NODE_ENV === 'production' && !process.env.MC_SCHEDULER_TIER)
    || process.env.DEBUG_PRISMA === '1';

export const prisma = basePrisma.$extends({
    query: {
        $allModels: {
            async $allOperations({ model, operation, args, query }) {
                if (LOG_PRISMA_QUERIES) {
                    console.info(`[DATABASE] Executing ${operation} on ${model}`);
                }
                return query(args);
            },
        },
    },
}) as unknown as typeof basePrisma;

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
