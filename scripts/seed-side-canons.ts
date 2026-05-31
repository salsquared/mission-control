/**
 * One-time idempotent seeder (docs/canonical-resumes.html §7 P1.6).
 *
 * Creates one SIDE canon per side keyword watchlist (linkedin/indeed), copying
 * the watchlist's keyword string into the canon's `keywords`, and links the
 * watchlist (`Watchlist.canonId`) so its jobs inherit the canon at
 * track-as-application time. Idempotent on (userId, slug) — re-running is a
 * no-op. Career canons are NOT seeded (added by hand).
 *
 * Run per DB:
 *   DATABASE_URL="file:./dev.db"  npx tsx scripts/seed-side-canons.ts
 *   DATABASE_URL="file:./prod.db" MC_SEED_USER_ID=<prodUserId> npx tsx scripts/seed-side-canons.ts
 *
 * User: MC_SEED_USER_ID env, else the single/first User row.
 */
import { prisma } from "@/lib/prisma";
import { normalizeRoleName } from "@/lib/applications/normalize-role";

async function main(): Promise<void> {
    const userId =
        process.env.MC_SEED_USER_ID ??
        (await prisma.user.findFirst({ select: { id: true } }))?.id;
    if (!userId) {
        console.error("[seed-side-canons] no user — set MC_SEED_USER_ID");
        process.exit(1);
    }

    const watchlists = await prisma.watchlist.findMany({
        where: { userId, track: "side", kind: { in: ["linkedin", "indeed"] } },
        select: { id: true, name: true, config: true, canonId: true },
    });
    console.log(`[seed-side-canons] ${watchlists.length} side keyword watchlist(s) for user ${userId}`);

    let created = 0;
    let linked = 0;
    let skipped = 0;
    for (const w of watchlists) {
        let keywords = "";
        try {
            const cfg = JSON.parse(w.config) as { keywords?: unknown };
            if (typeof cfg.keywords === "string") keywords = cfg.keywords;
        } catch {
            /* malformed config — seed with empty keywords, user can fill */
        }

        const name = w.name.trim();
        const slug = normalizeRoleName(name);
        if (!slug) {
            console.warn(`  skip "${name}" — normalizes to empty slug`);
            skipped++;
            continue;
        }

        // Upsert canon on (userId, slug).
        const existing = await prisma.canon.findFirst({ where: { userId, slug } });
        let canonId: string;
        if (existing) {
            canonId = existing.id;
            console.log(`  reuse canon "${existing.name}" (${slug})`);
        } else {
            const c = await prisma.canon.create({
                data: { userId, name, slug, track: "side", keywords },
            });
            canonId = c.id;
            created++;
            console.log(`  + canon "${name}" (${slug})`);
        }

        // Link the watchlist (idempotent; only write when it would change).
        if (w.canonId !== canonId) {
            await prisma.watchlist.update({ where: { id: w.id }, data: { canonId } });
            linked++;
        }
    }

    console.log(
        `[seed-side-canons] done — ${created} canon(s) created, ${linked} watchlist link(s) set, ${skipped} skipped`,
    );
}

main()
    .then(() => process.exit(0))
    .catch((e) => {
        console.error("[seed-side-canons] failed:", e);
        process.exit(1);
    });
