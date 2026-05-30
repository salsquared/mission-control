/**
 * One-off: create four `side` LinkedIn watchlists for no-degree, immediately-
 * employable categories derived from Sal's profile (1.1 AI coding evaluator,
 * 1.2 math/test-prep tutor, 2.1 bilingual CS/interpreter, 2.2 junior web dev & QA).
 *
 * One watchlist PER CATEGORY, using LinkedIn's native boolean OR inside the
 * single `keywords` string (the schema has no keyword array; the fetcher passes
 * keywords through verbatim, so OR/quoted-phrase queries work). Mirrors the
 * existing side-watchlist defaults: scheduleMinutes 240, notificationMode digest.
 *
 * Run against dev.db:  DATABASE_URL="file:./dev.db" npx tsx scripts/tests/debug/create-side-watchlists-noheard.ts
 * Idempotent: skips any watchlist whose name already exists for the user.
 */
import { prisma } from "@/lib/prisma";
import { WatchlistConfigSchema } from "@/lib/schemas/watchlists";

// Owner of the existing `side` security watchlists. Defaults to the dev.db
// user; override for prod.db via MC_WATCHLIST_USER_ID (prod = cmpeehlib…).
const USER_ID = process.env.MC_WATCHLIST_USER_ID ?? "cmopgsol80000t0fufy9u9rf1";

const NEW_WATCHLISTS = [
    {
        name: "AI coding evaluator — Remote",
        keywords: '"AI trainer" OR "coding expert" OR "data annotation" OR "AI coding" OR "LLM evaluator"',
        location: "United States",
    },
    {
        name: "Math / test-prep tutor — Los Angeles",
        keywords: '"math tutor" OR "SAT tutor" OR "ACT prep" OR "calculus tutor" OR "Mathnasium" OR "Kumon"',
        location: "Los Angeles",
    },
    {
        name: "Bilingual customer service / interpreter — Los Angeles",
        keywords: '"bilingual customer service" OR "Spanish interpreter" OR "bilingual call center" OR "Spanish translator"',
        location: "Los Angeles",
    },
    {
        name: "Junior web dev & QA — Remote",
        keywords: '"junior web developer" OR "frontend developer" OR "QA tester" OR "react developer" OR "junior software engineer"',
        location: "United States",
    },
] as const;

async function main() {
    for (const w of NEW_WATCHLISTS) {
        const config = {
            kind: "linkedin" as const,
            keywords: w.keywords,
            location: w.location,
            companyName: "LinkedIn search",
        };
        // Validate exactly as the POST route does (incl. the 200-char keyword cap).
        const parsed = WatchlistConfigSchema.safeParse(config);
        if (!parsed.success) {
            console.error(`[SKIP] "${w.name}" — invalid config:`, parsed.error.issues);
            continue;
        }
        const existing = await prisma.watchlist.findFirst({
            where: { userId: USER_ID, name: w.name },
        });
        if (existing) {
            console.info(`[SKIP] "${w.name}" — already exists (${existing.id})`);
            continue;
        }
        const row = await prisma.watchlist.create({
            data: {
                userId: USER_ID,
                name: w.name,
                kind: "linkedin",
                config: JSON.stringify(parsed.data),
                directoryKey: null,
                scheduleMinutes: 240,
                notificationMode: "digest",
                track: "side",
            },
        });
        console.info(`[CREATE] "${w.name}" → ${row.id}  (${w.keywords.length} keyword chars)`);
    }

    console.info("\n=== side watchlists now ===");
    const all = await prisma.watchlist.findMany({
        where: { userId: USER_ID, track: "side" },
        orderBy: { createdAt: "asc" },
    });
    for (const w of all) console.info(`  ${w.name}`);
}

main()
    .then(() => process.exit(0))
    .catch((e) => { console.error(e); process.exit(1); });
