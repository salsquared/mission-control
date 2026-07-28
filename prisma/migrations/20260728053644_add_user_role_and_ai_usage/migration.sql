-- CreateTable
CREATE TABLE "AiUsage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "AiUsage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT,
    "email" TEXT,
    "emailVerified" DATETIME,
    "image" TEXT,
    "lastSyncedHistoryId" TEXT,
    "role" TEXT NOT NULL DEFAULT 'crew'
);
INSERT INTO "new_User" ("email", "emailVerified", "id", "image", "lastSyncedHistoryId", "name") SELECT "email", "emailVerified", "id", "image", "lastSyncedHistoryId", "name" FROM "User";
DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "AiUsage_userId_day_key" ON "AiUsage"("userId", "day");

-- Owner promotion — HAND-ADDED AND INTENTIONALLY INLINE. Do not extract this to
-- a follow-up script (docs/multi-user-crew.html §2.10, OQ4a, R3).
--
-- `role` defaults to 'crew', so this migration applied WITHOUT its backfill
-- leaves the DB with zero role='owner' rows. That is not a cosmetic gap:
-- requireOwner() then 403s the owner out of their own app, and every
-- session-less resolveOwner() read — the scheduler's, both break-glass
-- branches' — returns NULL. A migration that CAN be applied without its
-- backfill eventually will be, so the promotion ships in the same SQL file.
--
-- Deterministic: dev.db and prod.db each hold exactly one User row
-- (salsalcedo4321@gmail.com, re-verified 2026-07-28 immediately before this
-- migration was generated), so the unqualified UPDATE promotes exactly that
-- row. Post-deploy check, run per tier: SELECT role, count(*) FROM "User"
-- GROUP BY role; — exactly one 'owner', and never two (two silently hands the
-- scheduler a non-owner). The same invariant is asserted hermetically.
UPDATE "User" SET role = 'owner';
