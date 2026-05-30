/**
 * Desync the four brainstorm `side` watchlists so they stop firing as a batch.
 *
 * Problem: created together → identical lastRunAt + identical scheduleMinutes=240
 * → they re-collide on the same scheduler tick every 4h (a back-to-back LinkedIn
 * burst). The existing two security watchlists are already phase-spread (10 min
 * apart) and share an equal period, so they stay spread — left untouched.
 *
 * Fix (data-only, no code change):
 *   - DISTINCT PRIME cadences near 240 (233/239/241/251). Pairwise-coprime →
 *     their least-common-multiple is enormous, so once spread they effectively
 *     never re-cluster (equal periods would lock them together forever).
 *   - One-time PHASE STAGGER, expressed as next-due (15 min apart, > the 10-min
 *     tick) so the very next re-crawl is guaranteed to land in four different
 *     ticks. We stagger by next-due (not lastRunAt) because the distinct
 *     cadences would otherwise partly cancel a lastRunAt offset; lastRunAt is
 *     then back-computed as nextDue − cadence.
 *
 *   DATABASE_URL="file:./dev.db" npx tsx scripts/tests/debug/desync-side-watchlist-cadence.ts
 */
import { prisma } from "@/lib/prisma";

const PRIME_CADENCES = [233, 239, 241, 251]; // minutes, pairwise coprime, ~240
const NEXTDUE_BASE_MIN = 180;    // first re-crawl ~3h out (they crawled fresh already)
const NEXTDUE_STAGGER_MIN = 15;  // > 10-min tick ⇒ each lands in a distinct tick

async function main() {
    const targets = await prisma.watchlist.findMany({
        where: { track: "side", active: true, NOT: { name: { startsWith: "security" } } },
        select: { id: true, name: true, lastRunAt: true },
        orderBy: { createdAt: "asc" },
    });

    if (targets.length === 0) {
        console.error("No non-security side watchlists found.");
        process.exit(1);
    }

    const now = Date.now();
    console.info("Desyncing cadence + phase:\n");
    for (let i = 0; i < targets.length; i++) {
        const w = targets[i];
        const cadence = PRIME_CADENCES[i % PRIME_CADENCES.length];
        // Stagger by NEXT-DUE (cadence-independent), then back-compute lastRunAt.
        const nextDue = new Date(now + (NEXTDUE_BASE_MIN + i * NEXTDUE_STAGGER_MIN) * 60_000);
        const lastRunAt = new Date(nextDue.getTime() - cadence * 60_000);
        await prisma.watchlist.update({
            where: { id: w.id },
            data: { scheduleMinutes: cadence, lastRunAt },
        });
        console.info(
            `  ${w.name}\n      cadence ${cadence}m  ·  lastRunAt ${lastRunAt.toISOString().slice(11, 19)}  ·  next-due ~${nextDue.toISOString().slice(11, 16)}`,
        );
    }
    console.info("\nDone. Restart not required — runDueWatchlists reads these every tick.");
}

main()
    .then(() => process.exit(0))
    .catch((e) => { console.error(e); process.exit(1); });
