import { prisma } from '@/lib/prisma';

// Liveness probe for the SQLite connection. Used by /api/system to surface
// dbConnected on the Internal Systems dash. Returns true on success, false on
// any error (caller decides how to surface the failure).
export async function pingDatabase(): Promise<boolean> {
    try {
        await prisma.$queryRaw`SELECT 1`;
        return true;
    } catch (e) {
        console.warn('[DATABASE] Ping failed:', e);
        return false;
    }
}
