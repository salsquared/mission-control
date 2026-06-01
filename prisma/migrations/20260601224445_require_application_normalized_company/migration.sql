-- 2026-06-01: make Application.normalizedCompany NOT NULL.
--
-- Closes the silent-duplicate class behind the Rocket Lab cards: a create path
-- that bypassed normalizeCompanyName (the legacy track-as-application leak) left
-- normalizedCompany NULL, which the indexed dedup lookup could never match, so
-- ingest AND track-as-application both spawned a second kanban card for an
-- application the user already had. NOT NULL turns that into a loud insert
-- failure at the offending call site instead of a duplicate found weeks later.
--
-- PRE-REQ (same pattern as 20260527231500_swap_application_unique_for_role):
--   DATABASE_URL="file:./<db>" npx tsx scripts/backfill-normalized-company.ts
-- must have been run on THIS db so no NULL/empty normalizedCompany rows remain.
-- The INSERT ... SELECT below copies normalizedCompany verbatim and the column
-- is NOT NULL, so any remaining NULL aborts the rebuild. If the backfill
-- reported a [skip-conflict], two rows share (company, role, track) — resolve
-- that duplicate by hand (merge the timelines) before re-running this migration.
/*
  Warnings:

  - Made the column `normalizedCompany` on table `Application` required. This step will fail if there are existing NULL values in that column.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Application" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "normalizedCompany" TEXT NOT NULL,
    "normalizedRole" TEXT,
    "sourceJobId" TEXT,
    "senderDomain" TEXT,
    "role" TEXT,
    "status" TEXT NOT NULL,
    "kind" TEXT,
    "nextSteps" TEXT,
    "dateApplied" DATETIME,
    "lastEmailMsgId" TEXT,
    "postingId" TEXT,
    "decisionDeadline" DATETIME,
    "lastUpdateAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "track" TEXT NOT NULL,
    "canonId" TEXT,
    CONSTRAINT "Application_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Application_postingId_fkey" FOREIGN KEY ("postingId") REFERENCES "JobPosting" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Application_canonId_fkey" FOREIGN KEY ("canonId") REFERENCES "Canon" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Application" ("canonId", "company", "createdAt", "dateApplied", "decisionDeadline", "id", "kind", "lastEmailMsgId", "lastUpdateAt", "nextSteps", "normalizedCompany", "normalizedRole", "postingId", "role", "senderDomain", "sourceJobId", "status", "track", "updatedAt", "userId") SELECT "canonId", "company", "createdAt", "dateApplied", "decisionDeadline", "id", "kind", "lastEmailMsgId", "lastUpdateAt", "nextSteps", "normalizedCompany", "normalizedRole", "postingId", "role", "senderDomain", "sourceJobId", "status", "track", "updatedAt", "userId" FROM "Application";
DROP TABLE "Application";
ALTER TABLE "new_Application" RENAME TO "Application";
CREATE UNIQUE INDEX "Application_postingId_key" ON "Application"("postingId");
CREATE INDEX "Application_userId_status_idx" ON "Application"("userId", "status");
CREATE INDEX "Application_userId_kind_idx" ON "Application"("userId", "kind");
CREATE INDEX "Application_userId_track_idx" ON "Application"("userId", "track");
CREATE INDEX "Application_canonId_idx" ON "Application"("canonId");
CREATE INDEX "Application_userId_senderDomain_idx" ON "Application"("userId", "senderDomain");
CREATE INDEX "Application_userId_sourceJobId_idx" ON "Application"("userId", "sourceJobId");
CREATE UNIQUE INDEX "Application_userId_normalizedCompany_normalizedRole_track_key" ON "Application"("userId", "normalizedCompany", "normalizedRole", "track");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
