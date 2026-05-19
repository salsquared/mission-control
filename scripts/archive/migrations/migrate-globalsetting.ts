/**
 * One-shot backfill: reads the legacy `data` JSON blob from GlobalSetting and
 * projects each field into the new typed columns. Idempotent — safe to re-run.
 *
 * Run once per environment:
 *   npx tsx scripts/migrate-globalsetting.ts
 */

import { PrismaClient } from '@prisma/client';

async function main() {
    const prisma = new PrismaClient();
    try {
        const row = await (prisma as any).globalSetting.findUnique({ where: { id: 'global' } });
        if (!row) {
            console.log('No GlobalSetting row found — nothing to migrate.');
            return;
        }

        if (!row.data) {
            console.log('No legacy `data` blob present — already migrated or empty.');
            return;
        }

        const blob = JSON.parse(row.data);

        await (prisma as any).globalSetting.update({
            where: { id: 'global' },
            data: {
                isDarkMode: blob.isDarkMode ?? true,
                viewHuesEnabled: blob.viewHuesEnabled ?? true,
                viewHues: blob.viewHues ? JSON.stringify(blob.viewHues) : null,
                dashOrder: blob.dashOrder ? JSON.stringify(blob.dashOrder) : null,
                dashTitles: blob.dashTitles ? JSON.stringify(blob.dashTitles) : null,
            },
        });

        console.log('Migration complete. Fields projected from legacy `data` blob to new columns.');
    } finally {
        await prisma.$disconnect();
    }
}

main().catch(err => { console.error(err); process.exit(1); });
