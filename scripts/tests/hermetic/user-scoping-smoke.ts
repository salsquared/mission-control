/**
 * Hermetic smoke for the OQ2a per-user scoping of the four formerly-global
 * tables (P2.1–P2.3, 2026-06-12): Task, LifeGoal, GlobalSetting, SavedPaper.
 *
 *   npx tsx scripts/tests/hermetic/user-scoping-smoke.ts
 *
 * Asserts:
 *   1. Repo-level isolation — an authenticated STRANGER sees empty sets across
 *      all four tables while the OWNER sees their rows; id-guessing another
 *      user's row 404s/throws instead of leaking; the SavedPaper upsert keyed
 *      on (userId, paperId) creates a sibling row rather than mutating the
 *      other user's.
 *   2. GlobalSetting per-user — one row per user; the stranger's bootstrap
 *      write never touches the owner's row; reads key on userId.
 *   3. /api/settings If-Match contract via the REAL route handlers over the
 *      LAN bypass (host=localhost, no session → lib/user-scope.ts owner
 *      fallback): GET returns the owner's parsed row; POST without If-Match
 *      → 428; stale version → 409 + currentVersion; matching version → 200
 *      with version+1 — byte-identical to the pre-rework contract.
 *   4. /api/tasks GET over the LAN bypass returns only the owner's tasks, and
 *      POST creates rows owned by the owner.
 *
 * Genuinely hermetic: no server, no network, no PM2 — the DB is a THROWAWAY
 * SQLite file in /tmp (DATABASE_URL pinned before any import; tables created
 * with raw DDL matching prisma/schema.prisma post-migration-20260612235207).
 * dev.db / prod.db are never touched.
 */
const TMP_DB = `/tmp/user-scoping-smoke-${process.pid}-${Date.now()}.db`;
process.env.DATABASE_URL = `file:${TMP_DB}`;
// Deterministic owner resolution for the LAN fallback: two users exist in the
// fixture DB, so the sole-user heuristic can't apply — the allowlist must pick.
const OWNER_EMAIL = "owner@user-scoping-smoke.invalid";
process.env.ALLOWED_SIGNIN_EMAILS = OWNER_EMAIL;
process.env.EMAIL_ENABLED = "0";

import { unlinkSync } from "node:fs";

let passes = 0;
let fails = 0;
function pass(msg: string) { console.log(`[PASS] ${msg}`); passes++; }
function fail(msg: string, detail?: unknown) { console.error(`[FAIL] ${msg}`, detail ?? ""); fails++; }

const DDL = [
    `CREATE TABLE "User" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "name" TEXT,
        "email" TEXT,
        "emailVerified" DATETIME,
        "image" TEXT,
        "lastSyncedHistoryId" TEXT
    )`,
    `CREATE UNIQUE INDEX "User_email_key" ON "User"("email")`,
    `CREATE TABLE "Task" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "userId" TEXT NOT NULL,
        "text" TEXT NOT NULL,
        "status" TEXT NOT NULL,
        "priority" TEXT,
        "project" TEXT,
        "dueDate" DATETIME,
        "position" INTEGER NOT NULL DEFAULT 0,
        "notes" TEXT,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL,
        "parentId" TEXT,
        CONSTRAINT "Task_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Task" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
        CONSTRAINT "Task_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
    )`,
    `CREATE TABLE "LifeGoal" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "userId" TEXT NOT NULL,
        "text" TEXT NOT NULL,
        "estimatedTime" TEXT,
        "completed" BOOLEAN NOT NULL DEFAULT false,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL,
        CONSTRAINT "LifeGoal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
    )`,
    `CREATE TABLE "GlobalSetting" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "userId" TEXT NOT NULL,
        "isDarkMode" BOOLEAN NOT NULL DEFAULT true,
        "viewHuesEnabled" BOOLEAN NOT NULL DEFAULT true,
        "viewHues" TEXT NOT NULL DEFAULT '{}',
        "dashOrder" TEXT NOT NULL DEFAULT '[]',
        "dashTitles" TEXT NOT NULL DEFAULT '{}',
        "globalNegativeFilters" TEXT NOT NULL DEFAULT '[]',
        "hiddenWatchlistIds" TEXT NOT NULL DEFAULT '[]',
        "quietHoursStart" TEXT,
        "quietHoursEnd" TEXT,
        "quietHoursTimezone" TEXT,
        "version" INTEGER NOT NULL DEFAULT 0,
        "updatedAt" DATETIME NOT NULL,
        CONSTRAINT "GlobalSetting_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
    )`,
    `CREATE UNIQUE INDEX "GlobalSetting_userId_key" ON "GlobalSetting"("userId")`,
    `CREATE TABLE "SavedPaper" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "userId" TEXT NOT NULL,
        "paperId" TEXT NOT NULL,
        "title" TEXT NOT NULL,
        "summary" TEXT NOT NULL,
        "url" TEXT NOT NULL,
        "authors" TEXT NOT NULL,
        "publishedAt" DATETIME NOT NULL,
        "topic" TEXT NOT NULL,
        "status" TEXT NOT NULL,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL,
        CONSTRAINT "SavedPaper_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
    )`,
    `CREATE UNIQUE INDEX "SavedPaper_userId_paperId_key" ON "SavedPaper"("userId", "paperId")`,
];

/** LAN-shaped request: host=localhost, no XFF, no session → owner fallback. */
function lanRequest(path: string, init: RequestInit = {}): Request {
    const headers = new Headers(init.headers);
    headers.set("host", "localhost");
    return new Request(`http://localhost${path}`, { ...init, headers });
}

/**
 * Route handlers' inferred return type carries a phantom `| undefined`
 * (pre-existing codebase-wide TS quirk — untouched routes show it too);
 * at runtime every path returns a NextResponse. Assert it for the smoke.
 */
function mustRespond<T>(r: T | undefined, label: string): T {
    if (r === undefined) throw new Error(`${label} returned undefined`);
    return r;
}

async function main() {
    // Dynamic imports: DATABASE_URL must be pinned before lib/prisma loads.
    const { prisma } = await import("@/lib/prisma");
    for (const ddl of DDL) await prisma.$executeRawUnsafe(ddl);

    const tasksRepo = await import("@/lib/repositories/tasks");
    const goalsRepo = await import("@/lib/repositories/goals");
    const papersRepo = await import("@/lib/repositories/saved-papers");
    const settingsRepo = await import("@/lib/repositories/settings");
    const { resolveOwnerUserId, _resetOwnerCache } = await import("@/lib/user-scope");

    const OWNER = "owner-user-scoping-smoke";
    const STRANGER = "stranger-user-scoping-smoke";

    try {
        await prisma.user.create({ data: { id: OWNER, email: OWNER_EMAIL } });
        await prisma.user.create({ data: { id: STRANGER, email: "stranger@user-scoping-smoke.invalid" } });

        // Owner fixtures across all four tables. The settings row mirrors the
        // migrated legacy singleton: id='global', owned by the owner.
        const ownerTask = await tasksRepo.createTask(OWNER, { text: "owner task 1", position: 1 });
        await tasksRepo.createTask(OWNER, { text: "owner task 2", position: 2, parentId: ownerTask.id });
        await goalsRepo.createGoal(OWNER, { text: "owner goal" });
        await papersRepo.upsertSavedPaper(OWNER, {
            paperId: "2406.00001", title: "Owner paper", summary: "s", url: "https://arxiv.org/abs/2406.00001",
            authors: "A", publishedAt: new Date("2026-06-01"), topic: "AI", status: "READ_LATER",
        });
        await prisma.globalSetting.create({
            data: { id: "global", userId: OWNER, isDarkMode: false, viewHues: '{"home":200}', version: 3 },
        });

        // ── 1. Repo-level isolation ─────────────────────────────────────────
        const strangerTasks = await tasksRepo.findAllTasks(STRANGER);
        const ownerTasks = await tasksRepo.findAllTasks(OWNER);
        if (strangerTasks.length !== 0) fail(`stranger sees ${strangerTasks.length} tasks (expected 0)`);
        else if (ownerTasks.length !== 2) fail(`owner sees ${ownerTasks.length} tasks (expected 2)`);
        else pass("Task: stranger sees empty set, owner sees their 2 rows");

        const strangerGoals = await goalsRepo.findAllGoals(STRANGER);
        const ownerGoals = await goalsRepo.findAllGoals(OWNER);
        if (strangerGoals.length !== 0) fail(`stranger sees ${strangerGoals.length} goals (expected 0)`);
        else if (ownerGoals.length !== 1) fail(`owner sees ${ownerGoals.length} goals (expected 1)`);
        else pass("LifeGoal: stranger sees empty set, owner sees their row");

        const strangerPapers = await papersRepo.findSavedPapers(STRANGER);
        const ownerPapers = await papersRepo.findSavedPapers(OWNER);
        if (strangerPapers.length !== 0) fail(`stranger sees ${strangerPapers.length} papers (expected 0)`);
        else if (ownerPapers.length !== 1) fail(`owner sees ${ownerPapers.length} papers (expected 1)`);
        else pass("SavedPaper: stranger sees empty set, owner sees their row");

        if (await settingsRepo.findGlobalSettingForUser(STRANGER) !== null) fail("stranger should have NO settings row");
        else if ((await settingsRepo.findGlobalSettingForUser(OWNER))?.version !== 3) fail("owner settings row missing/wrong");
        else pass("GlobalSetting: per-user read — stranger null, owner v3 row");

        // Cross-user id-guessing is inert.
        if (await tasksRepo.findTaskById(ownerTask.id, STRANGER) !== null) fail("stranger resolved the owner's task by id");
        else pass("Task: cross-user findTaskById returns null");
        let threw = false;
        try { await tasksRepo.updateTask(ownerTask.id, STRANGER, { text: "hijacked" }); } catch { threw = true; }
        const untouched = await tasksRepo.findTaskById(ownerTask.id, OWNER);
        if (!threw || untouched?.text !== "owner task 1") fail("stranger update on owner's task must throw and not mutate");
        else pass("Task: cross-user updateTask throws, row untouched");
        threw = false;
        try { await papersRepo.deleteSavedPaper(STRANGER, "2406.00001"); } catch { threw = true; }
        if (!threw || (await papersRepo.findSavedPapers(OWNER)).length !== 1) fail("stranger delete on owner's paper must throw and not delete");
        else pass("SavedPaper: cross-user delete throws, row untouched");

        // Same paperId, different users → sibling rows (compound unique).
        await papersRepo.upsertSavedPaper(STRANGER, {
            paperId: "2406.00001", title: "Stranger copy", summary: "s", url: "https://arxiv.org/abs/2406.00001",
            authors: "B", publishedAt: new Date("2026-06-01"), topic: "AI", status: "FAVORITE",
        });
        const ownerPaper = (await papersRepo.findSavedPapers(OWNER))[0];
        const strangerPaper = (await papersRepo.findSavedPapers(STRANGER))[0];
        if (ownerPaper?.status !== "READ_LATER" || strangerPaper?.status !== "FAVORITE") {
            fail("upsert by stranger must create a sibling row, not mutate the owner's", { ownerPaper, strangerPaper });
        } else pass("SavedPaper: (userId, paperId) upsert isolates users on the same paperId");

        // nextPosition is per-user.
        const strangerNext = await tasksRepo.nextPosition(null, STRANGER);
        if (strangerNext !== 1) fail(`stranger nextPosition should be 1 (own empty set), got ${strangerNext}`);
        else pass("Task: nextPosition scoped per user");

        // ── 2. GlobalSetting per-user write isolation ───────────────────────
        const boot = await settingsRepo.upsertGlobalSettingWithVersion(STRANGER, { isDarkMode: true }, 0);
        const ownerRowAfter = await settingsRepo.findGlobalSettingForUser(OWNER);
        const strangerRow = await settingsRepo.findGlobalSettingForUser(STRANGER);
        if (!boot.ok || boot.newVersion !== 1) fail("stranger first write should bootstrap version 1", boot);
        else if (ownerRowAfter?.version !== 3 || ownerRowAfter.isDarkMode !== false) fail("stranger bootstrap touched the owner's row", ownerRowAfter);
        else if (strangerRow?.version !== 1 || strangerRow.id === "global") fail("stranger row missing or collided with the legacy id", strangerRow);
        else pass("GlobalSetting: stranger bootstrap creates own row (v1), owner row untouched");

        const conflict = await settingsRepo.upsertGlobalSettingWithVersion(STRANGER, {}, 99);
        if (conflict.ok || conflict.currentVersion !== 1) fail("stale-version write should conflict with currentVersion 1", conflict);
        else pass("GlobalSetting: version mismatch surfaces currentVersion (per user)");

        // ── 3. /api/settings If-Match contract over the LAN bypass ──────────
        _resetOwnerCache();
        const resolved = await resolveOwnerUserId();
        if (resolved !== OWNER) fail(`owner resolution picked ${resolved} (expected ${OWNER} via allowlist)`);
        else pass("user-scope: allowlist resolves the owner among multiple users");

        const settingsRoute = await import("@/app/api/settings/route");
        const getRes = mustRespond(await settingsRoute.GET(lanRequest("/api/settings")), "settings GET");
        const getBody = await getRes.json();
        if (getRes.status !== 200 || getBody.data?.version !== 3 || getBody.data?.isDarkMode !== false) {
            fail("LAN GET /api/settings should return the OWNER's parsed row", getBody);
        } else pass("LAN GET /api/settings → owner's settings (session-less fallback)");

        const noIfMatch = mustRespond(await settingsRoute.POST(lanRequest("/api/settings", {
            method: "POST", body: JSON.stringify({ isDarkMode: true }),
        })), "settings POST (no If-Match)");
        if (noIfMatch.status !== 428) fail(`POST without If-Match should 428, got ${noIfMatch.status}`);
        else pass("POST /api/settings without If-Match → 428 (contract intact)");

        const stale = mustRespond(await settingsRoute.POST(lanRequest("/api/settings", {
            method: "POST", headers: { "if-match": "1" }, body: JSON.stringify({ isDarkMode: true }),
        })), "settings POST (stale)");
        const staleBody = await stale.json();
        if (stale.status !== 409 || staleBody.currentVersion !== 3) fail("stale If-Match should 409 with currentVersion 3", staleBody);
        else pass("POST /api/settings stale If-Match → 409 + currentVersion");

        const good = mustRespond(await settingsRoute.POST(lanRequest("/api/settings", {
            method: "POST", headers: { "if-match": "3" }, body: JSON.stringify({ isDarkMode: true }),
        })), "settings POST (good)");
        const goodBody = await good.json();
        if (good.status !== 200 || goodBody.version !== 4) fail("matching If-Match should 200 with version 4", goodBody);
        else pass("POST /api/settings matching If-Match → 200, version bumps to 4");

        const ownerFinal = await settingsRepo.findGlobalSettingForUser(OWNER);
        const strangerFinal = await settingsRepo.findGlobalSettingForUser(STRANGER);
        if (ownerFinal?.isDarkMode !== true || strangerFinal?.version !== 1) {
            fail("route write should land on the owner's row only", { ownerFinal, strangerFinal });
        } else pass("route write landed on the owner's row; stranger row untouched");

        // findGlobalSetting() (zero-arg, scheduler/postings path) → owner row.
        const schedulerView = await settingsRepo.findGlobalSetting();
        if (schedulerView?.userId !== OWNER || schedulerView.version !== 4) {
            fail("zero-arg findGlobalSetting should resolve the owner's row", schedulerView);
        } else pass("findGlobalSetting() (scheduler path) resolves the owner's row");

        // ── 4. /api/tasks over the LAN bypass ───────────────────────────────
        const tasksRoute = await import("@/app/api/tasks/route");
        const tasksGet = mustRespond(await tasksRoute.GET(lanRequest("/api/tasks")), "tasks GET");
        const tasksBody = await tasksGet.json();
        if (tasksGet.status !== 200 || tasksBody.tasks?.length !== 2) {
            fail(`LAN GET /api/tasks should list the owner's 2 tasks, got ${tasksBody.tasks?.length}`, tasksBody);
        } else if (tasksBody.tasks.some((t: { userId: string }) => t.userId !== OWNER)) {
            fail("LAN GET /api/tasks leaked a non-owner row", tasksBody.tasks);
        } else pass("LAN GET /api/tasks → owner's tasks only");

        const tasksPost = mustRespond(await tasksRoute.POST(lanRequest("/api/tasks", {
            method: "POST", body: JSON.stringify({ text: "created via LAN" }),
        })), "tasks POST");
        const postBody = await tasksPost.json();
        const createdRow = postBody.id ? await prisma.task.findUnique({ where: { id: postBody.id } }) : null;
        if (tasksPost.status !== 200 || createdRow?.userId !== OWNER) {
            fail("LAN POST /api/tasks should create a row owned by the owner", { status: tasksPost.status, createdRow });
        } else pass("LAN POST /api/tasks → new row owned by the owner");
    } finally {
        try { await prisma.$disconnect(); } catch { /* best-effort */ }
        for (const suffix of ["", "-journal", "-wal", "-shm"]) {
            try { unlinkSync(TMP_DB + suffix); } catch { /* may not exist */ }
        }
    }

    console.log(`\n${passes}/${passes + fails} steps passed`);
    if (fails > 0) process.exit(1);
    console.log("All checks passed.");
    process.exit(0);
}

main().catch((e) => {
    console.error("smoke crashed:", e);
    process.exit(1);
});
