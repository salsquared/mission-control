/**
 * On-demand crawl trigger for testing — fires the real crawl path (`runWatchlist`,
 * the same fn POST /api/watchlists/[id]/run uses) so you don't have to wait for
 * the 10-min scheduler tick. Crawls SERIALLY with a randomized gap between each
 * so a test run is never a tight burst against LinkedIn's guest endpoint.
 *
 *   DATABASE_URL="file:./dev.db" npx tsx scripts/tests/debug/crawl-watchlists-now.ts
 *       → crawls the 4 non-security `side` watchlists (the brainstorm batch)
 *   ... crawl-watchlists-now.ts all-side       → every `side` watchlist
 *   ... crawl-watchlists-now.ts "math"         → side watchlists whose name matches "math"
 *
 * NOTE: hits LinkedIn live. A single crawl = 2 page-fetches; safe. Don't loop
 * this — repeated bursts are what trip bot-detection, not one test.
 */
import { prisma } from "@/lib/prisma";
import { runWatchlist } from "@/scheduler/jobs/job-watcher";

const MIN_GAP_MS = 4_000;
const MAX_GAP_MS = 12_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jitter = () => Math.floor(MIN_GAP_MS + Math.random() * (MAX_GAP_MS - MIN_GAP_MS));

async function main() {
    const arg = process.argv[2]?.trim().toLowerCase();

    const sideAll = await prisma.watchlist.findMany({
        where: { track: "side", active: true },
        select: { id: true, name: true },
        orderBy: { createdAt: "asc" },
    });

    let targets;
    if (arg === "all-side") {
        targets = sideAll;
    } else if (arg) {
        targets = sideAll.filter((w) => w.name.toLowerCase().includes(arg));
    } else {
        // default: the brainstorm batch = side watchlists that aren't the security ones
        targets = sideAll.filter((w) => !w.name.toLowerCase().startsWith("security"));
    }

    if (targets.length === 0) {
        console.error(`No matching side watchlists (arg=${arg ?? "<none>"}).`);
        process.exit(1);
    }

    console.info(`Crawling ${targets.length} watchlist(s), ${MIN_GAP_MS / 1000}-${MAX_GAP_MS / 1000}s jittered gap between each:\n`);
    for (let i = 0; i < targets.length; i++) {
        const w = targets[i];
        const t0 = Date.now();
        const r = await runWatchlist(w.id);
        const secs = ((Date.now() - t0) / 1000).toFixed(1);
        const status = r.error ? `ERROR: ${r.error}` : `${r.newPostings} new, ${r.seenAgain} seen-again, ${r.closed} closed`;
        console.info(`  [${i + 1}/${targets.length}] ${w.name}  (${secs}s)  →  ${status}`);
        if (i < targets.length - 1) {
            const gap = jitter();
            console.info(`        …waiting ${(gap / 1000).toFixed(1)}s`);
            await sleep(gap);
        }
    }
}

main()
    .then(() => process.exit(0))
    .catch((e) => { console.error(e); process.exit(1); });
