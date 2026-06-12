-- P2.1 (OQ2a) — scope the four formerly-global tables (Task, LifeGoal,
-- GlobalSetting, SavedPaper) per userId.
--
-- Hand-authored three-step shape so `prisma migrate deploy` applies cleanly,
-- unattended, on a DB that already has rows:
--   1. add `userId` NULLABLE,
--   2. backfill every existing row to the owner account — resolved per-DB by
--      email subquery (dev.db and prod.db have different User ids),
--   3. SQLite table-rebuild to make `userId` NOT NULL + FK (Prisma's
--      RedefineTables pattern, generated then edited to carry userId).
-- A row whose owner cannot be resolved stays NULL after step 2 and fails the
-- NOT NULL rebuild loudly — by design: existing rows imply the owner User
-- exists (verified on both tiers before authoring).
--
-- GlobalSetting becomes one-row-PER-USER (unique userId); the legacy
-- singleton keeps its id='global' and becomes the owner's row.
-- SavedPaper's global `paperId` unique becomes the compound (userId, paperId)
-- so two users can save the same paper.

-- Step 1+2: nullable add + owner backfill
ALTER TABLE "Task" ADD COLUMN "userId" TEXT;
UPDATE "Task" SET "userId" = (SELECT "id" FROM "User" WHERE "email" = 'salsalcedo4321@gmail.com');

ALTER TABLE "LifeGoal" ADD COLUMN "userId" TEXT;
UPDATE "LifeGoal" SET "userId" = (SELECT "id" FROM "User" WHERE "email" = 'salsalcedo4321@gmail.com');

ALTER TABLE "GlobalSetting" ADD COLUMN "userId" TEXT;
UPDATE "GlobalSetting" SET "userId" = (SELECT "id" FROM "User" WHERE "email" = 'salsalcedo4321@gmail.com');

ALTER TABLE "SavedPaper" ADD COLUMN "userId" TEXT;
UPDATE "SavedPaper" SET "userId" = (SELECT "id" FROM "User" WHERE "email" = 'salsalcedo4321@gmail.com');

-- Step 3 — RedefineTables (NOT NULL + FK + new indexes)
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_GlobalSetting" (
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
);
INSERT INTO "new_GlobalSetting" ("dashOrder", "dashTitles", "globalNegativeFilters", "hiddenWatchlistIds", "id", "isDarkMode", "quietHoursEnd", "quietHoursStart", "quietHoursTimezone", "updatedAt", "userId", "version", "viewHues", "viewHuesEnabled") SELECT "dashOrder", "dashTitles", "globalNegativeFilters", "hiddenWatchlistIds", "id", "isDarkMode", "quietHoursEnd", "quietHoursStart", "quietHoursTimezone", "updatedAt", "userId", "version", "viewHues", "viewHuesEnabled" FROM "GlobalSetting";
DROP TABLE "GlobalSetting";
ALTER TABLE "new_GlobalSetting" RENAME TO "GlobalSetting";
CREATE UNIQUE INDEX "GlobalSetting_userId_key" ON "GlobalSetting"("userId");
CREATE TABLE "new_LifeGoal" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "estimatedTime" TEXT,
    "completed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "LifeGoal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_LifeGoal" ("completed", "createdAt", "estimatedTime", "id", "text", "updatedAt", "userId") SELECT "completed", "createdAt", "estimatedTime", "id", "text", "updatedAt", "userId" FROM "LifeGoal";
DROP TABLE "LifeGoal";
ALTER TABLE "new_LifeGoal" RENAME TO "LifeGoal";
CREATE INDEX "LifeGoal_userId_idx" ON "LifeGoal"("userId");
CREATE TABLE "new_SavedPaper" (
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
);
INSERT INTO "new_SavedPaper" ("authors", "createdAt", "id", "paperId", "publishedAt", "status", "summary", "title", "topic", "updatedAt", "url", "userId") SELECT "authors", "createdAt", "id", "paperId", "publishedAt", "status", "summary", "title", "topic", "updatedAt", "url", "userId" FROM "SavedPaper";
DROP TABLE "SavedPaper";
ALTER TABLE "new_SavedPaper" RENAME TO "SavedPaper";
CREATE INDEX "SavedPaper_status_topic_idx" ON "SavedPaper"("status", "topic");
CREATE UNIQUE INDEX "SavedPaper_userId_paperId_key" ON "SavedPaper"("userId", "paperId");
CREATE TABLE "new_Task" (
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
);
INSERT INTO "new_Task" ("createdAt", "dueDate", "id", "notes", "parentId", "position", "priority", "project", "status", "text", "updatedAt", "userId") SELECT "createdAt", "dueDate", "id", "notes", "parentId", "position", "priority", "project", "status", "text", "updatedAt", "userId" FROM "Task";
DROP TABLE "Task";
ALTER TABLE "new_Task" RENAME TO "Task";
CREATE INDEX "Task_userId_idx" ON "Task"("userId");
CREATE INDEX "Task_status_idx" ON "Task"("status");
CREATE INDEX "Task_position_idx" ON "Task"("position");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
