/**
 * End-to-end smoke for MB Phase 1 (watchlists + crawler + notifications).
 *
 *   DATABASE_URL="file:./dev.db" npx tsx scripts/tests/integration/watchlist-e2e-smoke.ts
 *
 * PREMISE REPAIR (2026-08-01). This suite used to hardcode Anthropic's
 * Greenhouse board and assume the owner did not already watch it. They do —
 * a real watchlist created 2026-05-17, still active — so `POST /api/watchlists`
 * answered 409 `That job board is already watched as "Anthropic"` and the run
 * died on step 1. The dedup guard (app/api/watchlists/route.ts:198) is right;
 * the ASSUMPTION was wrong, and it is not an assumption any suite can make
 * against a real dev.db whose contents change with the owner's job hunt.
 *
 * Three things changed, all so the suite owns its own fixture:
 *
 *   1. SELF-SEEDING BOARD (`selectBoard`). The board is chosen at runtime: read
 *      the owner's watchlists, compute their `watchlistConfigKey`s, and pick a
 *      Greenhouse board from COMPANY_DIRECTORY that is NOT already keyed —
 *      preferring the smallest live one, since a first crawl classifies every
 *      new posting through Gemini. A live board is still used deliberately (the
 *      point of the suite is the real fetch → ingest → notify chain); what is
 *      gone is the dependency on WHICH board, and on it being un-watched.
 *
 *   2. NOTIFICATIONS ARE SCOPED TO THIS RUN. Step 5 used to assert on the
 *      GLOBAL unread count and then delete every notification it saw — i.e. it
 *      passed on the owner's real unread rows and then DESTROYED them. It now
 *      counts only rows whose payload names this watchlist, and asserts the
 *      real first-crawl contract: ≤ FIRST_RUN_NOTIFY_LIMIT fetched postings
 *      notify per posting, more than that suppresses per-posting notification
 *      entirely (job-watcher.ts's `willNotifyForNew`). `markAllRead` coverage
 *      was dropped with it — there is no way to exercise that endpoint against
 *      a live dev.db without marking the owner's real notifications read.
 *
 *   3. CLEANUP ON EVERY EXIT PATH. Five orphaned fixture watchlists from a
 *      2026-06-24 run were found on 2026-08-01 still crawling live job boards.
 *      So: a leftover sweep by name prefix BEFORE the run, cleanup in `finally`
 *      AND on SIGINT/SIGTERM, and a verified delete that escalates
 *      API DELETE → direct row delete → deactivate-and-shout rather than
 *      swallowing the failure.
 *
 * If the chosen board is unreachable the smoke exits cleanly with a skip —
 * the test environment shouldn't gate on a third party.
 */
import { PrismaClient } from "@prisma/client";
import { randomBytes } from "crypto";
import { COMPANY_DIRECTORY, watchlistConfigKey } from "@/lib/company-directory";
import { WatchlistConfigSchema } from "@/lib/schemas/watchlists";

const BASE = process.env.MC_BASE_URL ?? "http://localhost:4101";

/**
 * Every watchlist this suite creates is named with this prefix. It is the
 * handle the leftover sweep grabs, so a run killed mid-flight (Ctrl-C, laptop
 * sleep, `pm2 restart` under it) cannot leave a crawler running forever — the
 * next run reaps it. Do not make the prefix run-unique; the whole point is that
 * it is stable across runs.
 */
const FIXTURE_PREFIX = "[smoke] watchlist-e2e — ";
const RUN_TAG = randomBytes(3).toString("hex");

/**
 * Mirror of `FIRST_RUN_NOTIFY_LIMIT` in scheduler/jobs/job-watcher.ts (it is a
 * function-local const, not exported). A first crawl returning MORE than this
 * many postings records them all but fires no per-posting notification, so the
 * user isn't buried under 400 unread rows. Keep in sync — step 5 asserts both
 * sides of it.
 */
const FIRST_RUN_NOTIFY_LIMIT = 20;

/** How many candidate boards to probe before giving up / choosing. */
const MAX_BOARD_PROBES = 6;

const prisma = new PrismaClient();

let passes = 0;
let fails = 0;
function pass(msg: string) { console.log(`[PASS] ${msg}`); passes++; }
function fail(msg: string, detail?: unknown) {
    console.error(`[FAIL] ${msg}`, detail ?? "");
    fails++;
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

interface WatchlistRow {
    id: string;
    name: string;
    config: unknown;
    lastRunAt: string | null;
    lastSuccessAt: string | null;
    lastError: string | null;
}

interface Board { slug: string; company: string; jobCount: number }

const greenhouseApi = (slug: string) =>
    `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs`;

async function listWatchlists(cookie: string): Promise<WatchlistRow[]> {
    const r = await fetch(`${BASE}/api/watchlists`, { headers: { Cookie: cookie } });
    if (r.status !== 200) throw new Error(`GET /api/watchlists → HTTP ${r.status}`);
    const body = await r.json() as { watchlists: WatchlistRow[] };
    return body.watchlists ?? [];
}

/**
 * Reap fixture watchlists left behind by a killed run. Uses the API DELETE so
 * the same cascade (postings + orphan side-canon) runs as in normal cleanup.
 */
async function sweepLeftovers(cookie: string, rows: WatchlistRow[]): Promise<void> {
    const stale = rows.filter(w => w.name.startsWith(FIXTURE_PREFIX));
    if (stale.length === 0) return;
    console.warn(
        `[sweep] ${stale.length} leftover fixture watchlist(s) from a previous run — ` +
        `deleting: ${stale.map(w => `${w.name} (${w.id})`).join(", ")}`,
    );
    for (const w of stale) {
        const r = await fetch(`${BASE}/api/watchlists/${w.id}`, { method: "DELETE", headers: { Cookie: cookie } })
            .catch(() => null);
        if (!r || r.status !== 200) console.warn(`[sweep] could not delete ${w.id} (HTTP ${r?.status ?? "network error"})`);
    }
}

/**
 * Pick a live Greenhouse board the owner is NOT already watching.
 *
 * `taken` holds the `watchlistConfigKey` of every watchlist the owner has, so
 * the choice is derived from the same identity function the 409 guard uses —
 * if that rule ever changes, this follows it instead of drifting.
 */
async function selectBoard(taken: Set<string>): Promise<Board | null> {
    const candidates: { slug: string; company: string }[] = [];
    for (const entry of COMPANY_DIRECTORY) {
        if (entry.config.kind !== "greenhouse") continue;
        const slug = entry.config.boardSlug;
        if (taken.has(`greenhouse:${slug.toLowerCase()}`)) continue;
        candidates.push({ slug, company: entry.name });
    }
    if (candidates.length === 0) return null;

    const probed: Board[] = [];
    for (const c of candidates.slice(0, MAX_BOARD_PROBES)) {
        try {
            const r = await fetch(greenhouseApi(c.slug), { signal: AbortSignal.timeout(8000) });
            if (!r.ok) { console.log(`[board] ${c.slug}: HTTP ${r.status} — skipping`); continue; }
            const body = await r.json() as { jobs?: unknown[] };
            const jobCount = Array.isArray(body.jobs) ? body.jobs.length : 0;
            console.log(`[board] ${c.slug}: ${jobCount} job(s)`);
            if (jobCount >= 1) probed.push({ ...c, jobCount });
        } catch (e) {
            console.log(`[board] ${c.slug}: unreachable (${e instanceof Error ? e.message : String(e)}) — skipping`);
        }
    }
    if (probed.length === 0) return null;
    // Smallest live board wins: a first crawl runs the inline Gemini
    // employment-type classifier over every new posting, so a 400-job board
    // makes this smoke both slow and expensive for no extra coverage.
    probed.sort((a, b) => a.jobCount - b.jobCount);
    return probed[0];
}

async function main() {
    // Pinned to the OWNER deliberately. The dev break-glass resolves every
    // request to the owner, so a fixture created as anyone else disagrees with
    // the identity the handlers will see. An unpinned findFirst() returns an
    // arbitrary row, and dev.db has held crew rows since 2026-08-01 — it still
    // happens to return the owner by insertion order, which is luck, not design.
    const user = await prisma.user.findFirst({ where: { role: "owner" } });
    if (!user) {
        console.error("No user in dev.db — log in first.");
        process.exit(1);
    }
    console.log(`Using user ${user.email}`);
    const ownerId = user.id;

    const sessionToken = randomBytes(32).toString("hex");
    await prisma.session.create({
        data: { sessionToken, userId: user.id, expires: new Date(Date.now() + 60 * 60 * 1000) },
    });
    const cookie = `__Secure-next-auth.session-token=${sessionToken}`;
    const headers = { "Content-Type": "application/json", Cookie: cookie };

    let watchlistId = "";
    let cleanedUp = false;

    /**
     * Idempotent — runs from `finally` AND from the signal handlers, whichever
     * gets there first. Escalates rather than swallowing: a fixture watchlist
     * that survives this function is a crawler pointed at a live job board with
     * nobody left to stop it.
     */
    async function cleanup(): Promise<void> {
        if (cleanedUp) return;
        cleanedUp = true;
        if (watchlistId) {
            // Notifications first — scoped to THIS watchlist by payload, never
            // a blanket delete of whatever the bell happened to be showing.
            await prisma.notification.deleteMany({
                where: { userId: ownerId, kind: "posting", payload: { contains: watchlistId } },
            }).catch(() => undefined);

            await fetch(`${BASE}/api/watchlists/${watchlistId}`, { method: "DELETE", headers: { Cookie: cookie } })
                .catch(() => undefined);
            const survivor = await prisma.watchlist.findUnique({ where: { id: watchlistId } }).catch(() => null);
            if (survivor) {
                // API delete failed (server down mid-run, 500). Postings cascade
                // on the FK, so a direct delete is equivalent minus the canon
                // sweep — which a fixture watchlist never has.
                const deleted = await prisma.watchlist.delete({ where: { id: watchlistId } }).then(() => true, () => false);
                if (!deleted) {
                    const paused = await prisma.watchlist
                        .update({ where: { id: watchlistId }, data: { active: false } })
                        .then(() => true, () => false);
                    console.error(
                        `[cleanup] COULD NOT DELETE fixture watchlist ${watchlistId} — ` +
                        (paused ? "deactivated it instead; delete it by hand." : "AND could not deactivate it. IT IS STILL CRAWLING. Delete it by hand."),
                    );
                }
            }
        }
        await prisma.session.delete({ where: { sessionToken } }).catch(() => undefined);
        await prisma.$disconnect().catch(() => undefined);
    }

    // A killed run is exactly how the 2026-06-24 orphans happened. `finally`
    // does not run on a signal, so wire the signals to the same cleanup.
    for (const sig of ["SIGINT", "SIGTERM"] as const) {
        process.once(sig, () => {
            console.warn(`\n[${sig}] cleaning up before exit...`);
            void cleanup().finally(() => process.exit(130));
        });
    }

    try {
        // 0. Reap leftovers, then choose a board the owner does not watch.
        const existing = await listWatchlists(cookie);
        await sweepLeftovers(cookie, existing);

        const taken = new Set<string>();
        for (const w of await listWatchlists(cookie)) {
            const parsed = WatchlistConfigSchema.safeParse(w.config);
            if (!parsed.success) continue; // unparseable legacy row can't collide
            const key = watchlistConfigKey(parsed.data);
            if (key) taken.add(key);
        }
        console.log(`[setup] owner already watches ${taken.size} board-identified watchlist(s)`);

        const board = await selectBoard(taken);
        if (!board) {
            console.warn("[SKIP] no un-watched Greenhouse board was reachable with ≥ 1 posting — skipping without failing.");
            await cleanup();
            process.exit(0);
        }
        console.log(`[setup] using ${board.company} (greenhouse:${board.slug}) — ${board.jobCount} jobs`);

        // 1. POST a watchlist. A 409 here means the un-watched pre-check above
        //    disagreed with the route's dedup rule — a real finding, not noise.
        {
            const r = await fetch(`${BASE}/api/watchlists`, {
                method: "POST", headers,
                body: JSON.stringify({
                    name: `${FIXTURE_PREFIX}${board.company} ${RUN_TAG}`,
                    config: {
                        kind: "greenhouse",
                        boardSlug: board.slug,
                        companyName: board.company,
                    },
                    // Deliberately slow: if cleanup somehow fails, a leaked row
                    // crawls daily rather than hourly. Nothing here depends on
                    // the cadence — every crawl in this suite is explicit.
                    scheduleMinutes: 1440,
                    notificationMode: "each",
                }),
            });
            const body = await r.json();
            if (r.status === 409) {
                return fail(
                    `POST /api/watchlists → 409 for a board that is NOT in the owner's watchlistConfigKey set — ` +
                    `the suite's dedup pre-check and app/api/watchlists/route.ts disagree`,
                    body,
                );
            }
            if (r.status !== 200) return fail(`POST /api/watchlists status ${r.status}`, body);
            watchlistId = body.watchlist.id;
            pass(`POST /api/watchlists → ${watchlistId}`);
        }

        // 2. Wait for the INITIAL crawl. The POST handler fires
        //    `runWatchlist(row.id)` fire-and-forget (route.ts:259) so the user
        //    sees postings within seconds. That makes "POST then immediately
        //    /run and expect N new postings" a race — `processOne` de-dupes
        //    in-flight runs by id, so the explicit /run either JOINS the initial
        //    crawl (N new) or follows it (0 new), depending on timing. Poll for
        //    the initial crawl to land instead, then let step 5 own the dedup
        //    assertion against a settled watchlist.
        let firstCrawl: WatchlistRow | null = null;
        {
            const deadline = Date.now() + 180_000;
            while (Date.now() < deadline) {
                const row = (await listWatchlists(cookie)).find(w => w.id === watchlistId) ?? null;
                if (row?.lastRunAt) { firstCrawl = row; break; }
                await sleep(2000);
            }
            if (!firstCrawl) return fail("initial crawl never recorded a lastRunAt within 180s");
            if (firstCrawl.lastError) return fail("initial crawl reported an error", firstCrawl.lastError);
            if (!firstCrawl.lastSuccessAt) return fail("initial crawl set lastRunAt but not lastSuccessAt", firstCrawl);
            pass(`initial crawl completed at ${firstCrawl.lastSuccessAt}`);
        }

        // 3. Verify postings landed
        let createdPostingIds: string[] = [];
        {
            const r = await fetch(`${BASE}/api/postings?watchlistId=${watchlistId}&status=new`, { headers: { Cookie: cookie } });
            const body = await r.json();
            if (r.status !== 200) return fail(`GET postings status ${r.status}`, body);
            if (body.postings.length < 1) {
                return fail(
                    `expected ≥ 1 posting in the new feed, got 0 — the board returned ${board.jobCount} jobs, so either ` +
                    `the greenhouse fetcher broke or the owner's GLOBAL negative filter dropped every one at ingest`,
                );
            }
            createdPostingIds = body.postings.map((p: { id: string }) => p.id);
            pass(`GET postings returned ${body.postings.length} rows`);
            console.log(`  Example: ${body.postings[0].company} — ${body.postings[0].title}`);
        }

        // 4. Notification contract for a FIRST crawl, scoped to this watchlist.
        //    Both branches are real assertions:
        //      - fetched ≤ limit  → one low-tier row per new posting
        //      - created > limit  → (so fetched > limit) per-posting notification
        //        is suppressed entirely; exactly 0 rows
        //    The gap between them (fetched > limit but created ≤ limit, i.e. the
        //    board shrank between probe and crawl) is unassertable, so it notes.
        let runNotificationIds: string[] = [];
        {
            const rows = await prisma.notification.findMany({
                where: { userId: ownerId, kind: "posting", payload: { contains: watchlistId } },
                select: { id: true, tier: true },
            });
            runNotificationIds = rows.map(r => r.id);
            if (board.jobCount <= FIRST_RUN_NOTIFY_LIMIT) {
                if (rows.length < 1) {
                    fail(
                        `expected ≥ 1 posting notification for this watchlist (board returned ${board.jobCount} ` +
                        `≤ ${FIRST_RUN_NOTIFY_LIMIT}, so the first-run digest suppression does not apply), got 0`,
                    );
                } else {
                    pass(`${rows.length} posting notification(s) fired for this watchlist`);
                }
                const wrongTier = rows.filter(r => r.tier !== "low");
                if (wrongTier.length > 0) fail(`posting notifications must be low-tier`, wrongTier);
                else if (rows.length > 0) pass("posting notifications are low-tier (in-app only, never emailed)");
            } else if (createdPostingIds.length > FIRST_RUN_NOTIFY_LIMIT) {
                if (rows.length !== 0) {
                    fail(
                        `expected 0 posting notifications on a first crawl of ${board.jobCount} postings ` +
                        `(> FIRST_RUN_NOTIFY_LIMIT ${FIRST_RUN_NOTIFY_LIMIT}), got ${rows.length}`,
                    );
                } else {
                    pass(`first-crawl notification suppression held (${board.jobCount} postings, 0 notifications)`);
                }
            } else {
                console.warn(
                    `[NOTE] board straddles FIRST_RUN_NOTIFY_LIMIT between probe (${board.jobCount}) and crawl ` +
                    `(${createdPostingIds.length}) — notification count ${rows.length} not asserted`,
                );
            }
        }

        // 5. Trigger a SECOND run — dedup should kick in. Deterministic now that
        //    step 2 confirmed the initial crawl finished: this is a fresh run,
        //    not a join of the in-flight one.
        {
            const r = await fetch(`${BASE}/api/watchlists/${watchlistId}/run`, {
                method: "POST", headers: { Cookie: cookie },
            });
            const body = await r.json();
            if (r.status !== 200) return fail(`POST /run (re-run) status ${r.status}`, body);
            console.log(`[verify] second run: ${body.newPostings} new, ${body.seenAgain} seen-again`);
            if (body.newPostings !== 0) fail(`expected 0 new postings on re-run (dedup), got ${body.newPostings}`);
            else pass("re-run created 0 new postings (dedup working)");
            if (body.seenAgain < 1) fail(`expected ≥ 1 seen-again on re-run, got ${body.seenAgain}`);
            else pass(`re-run saw ${body.seenAgain} postings again`);
        }

        // 6. PATCH one posting to "tracked"
        {
            const id = createdPostingIds[0];
            const r = await fetch(`${BASE}/api/postings/${id}`, {
                method: "PATCH", headers,
                body: JSON.stringify({ status: "tracked" }),
            });
            const body = await r.json();
            if (r.status !== 200) return fail(`PATCH posting status ${r.status}`, body);
            if (body.posting.status !== "tracked") fail("PATCH didn't echo new status", body);
            else pass(`PATCH posting → tracked`);

            // It should now be absent from the new feed
            const r2 = await fetch(`${BASE}/api/postings?status=new&watchlistId=${watchlistId}`, { headers: { Cookie: cookie } });
            const b2 = await r2.json();
            if (b2.postings.some((p: { id: string }) => p.id === id)) {
                fail("tracked posting still appears in 'new' feed");
            } else {
                pass("tracked posting no longer in 'new' feed");
            }
        }

        // 7. Mark THIS RUN's notifications read. Deliberately not `markAllRead`:
        //    that endpoint has no scope parameter, so exercising it here would
        //    mark the owner's real unread notifications read on every smoke run.
        //    The ids branch of the same PATCH is what the bell actually calls
        //    per-row anyway.
        if (runNotificationIds.length > 0) {
            const r = await fetch(`${BASE}/api/notifications`, {
                method: "PATCH", headers,
                body: JSON.stringify({ ids: runNotificationIds, readAt: new Date().toISOString() }),
            });
            const body = await r.json();
            if (r.status !== 200) return fail(`PATCH notifications (readAt) status ${r.status}`, body);
            if (body.updated !== runNotificationIds.length) {
                fail(`PATCH readAt updated=${body.updated}, expected ${runNotificationIds.length}`);
            } else {
                pass(`PATCH marked this run's ${body.updated} notification(s) read`);
            }

            const r2 = await fetch(`${BASE}/api/notifications?unread=true&limit=200`, { headers: { Cookie: cookie } });
            const b2 = await r2.json();
            const stillUnread = (b2.notifications ?? []).filter((n: { id: string }) => runNotificationIds.includes(n.id));
            if (stillUnread.length > 0) fail(`${stillUnread.length} of this run's notifications still unread after PATCH`);
            else pass("this run's notifications no longer appear in the unread feed");
        } else {
            console.log("[NOTE] no notifications from this run — skipping the read-PATCH step");
        }

        // 8. Negative — PATCH posting with invalid status
        {
            const r = await fetch(`${BASE}/api/postings/${createdPostingIds[0]}`, {
                method: "PATCH", headers,
                body: JSON.stringify({ status: "garbage" }),
            });
            if (r.status !== 400) fail(`PATCH invalid status expected 400 got ${r.status}`);
            else pass("PATCH posting invalid status → 400");
        }
    } finally {
        await cleanup();
    }
}

/**
 * THE EXIT PATH LIVES OUT HERE — DO NOT MOVE IT BACK INTO `main()`.
 *
 * The summary + `process.exit(1)` used to sit inside the `finally`, which meant
 * every `return fail(...)` above reached it only by luck of block ordering, and
 * an exit from inside a `finally` masks whatever the `try` threw. Running the
 * verdict from `.then()` makes it unskippable and keeps cleanup ahead of it —
 * same fix as the sibling suites' 0a235be.
 */
function finish(): never {
    console.log(`\n${passes}/${passes + fails} steps passed`);
    if (fails > 0) process.exit(1);
    console.log("All checks passed.");
    process.exit(0);
}

main().then(finish, e => {
    console.error("Unhandled error:", e);
    process.exit(2);
});
