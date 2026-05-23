-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Application" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "normalizedCompany" TEXT,
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
    "track" TEXT NOT NULL DEFAULT 'career',
    CONSTRAINT "Application_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Application_postingId_fkey" FOREIGN KEY ("postingId") REFERENCES "JobPosting" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Application" ("company", "createdAt", "dateApplied", "decisionDeadline", "id", "kind", "lastEmailMsgId", "lastUpdateAt", "nextSteps", "normalizedCompany", "postingId", "role", "senderDomain", "status", "updatedAt", "userId") SELECT "company", "createdAt", "dateApplied", "decisionDeadline", "id", "kind", "lastEmailMsgId", "lastUpdateAt", "nextSteps", "normalizedCompany", "postingId", "role", "senderDomain", "status", "updatedAt", "userId" FROM "Application";
DROP TABLE "Application";
ALTER TABLE "new_Application" RENAME TO "Application";
CREATE UNIQUE INDEX "Application_postingId_key" ON "Application"("postingId");
CREATE INDEX "Application_userId_status_idx" ON "Application"("userId", "status");
CREATE INDEX "Application_userId_kind_idx" ON "Application"("userId", "kind");
CREATE INDEX "Application_userId_track_idx" ON "Application"("userId", "track");
CREATE INDEX "Application_userId_senderDomain_idx" ON "Application"("userId", "senderDomain");
CREATE UNIQUE INDEX "Application_userId_normalizedCompany_track_key" ON "Application"("userId", "normalizedCompany", "track");
CREATE TABLE "new_Watchlist" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "config" TEXT NOT NULL,
    "directoryKey" TEXT,
    "negativeFilters" TEXT,
    "notificationMode" TEXT NOT NULL DEFAULT 'each',
    "lastDigestAt" DATETIME,
    "scheduleMinutes" INTEGER NOT NULL DEFAULT 30,
    "lastRunAt" DATETIME,
    "lastSuccessAt" DATETIME,
    "lastError" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "track" TEXT NOT NULL DEFAULT 'career',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Watchlist_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Watchlist" ("active", "config", "createdAt", "directoryKey", "id", "kind", "lastDigestAt", "lastError", "lastRunAt", "lastSuccessAt", "name", "negativeFilters", "notificationMode", "scheduleMinutes", "updatedAt", "userId") SELECT "active", "config", "createdAt", "directoryKey", "id", "kind", "lastDigestAt", "lastError", "lastRunAt", "lastSuccessAt", "name", "negativeFilters", "notificationMode", "scheduleMinutes", "updatedAt", "userId" FROM "Watchlist";
DROP TABLE "Watchlist";
ALTER TABLE "new_Watchlist" RENAME TO "Watchlist";
CREATE INDEX "Watchlist_userId_active_idx" ON "Watchlist"("userId", "active");
CREATE INDEX "Watchlist_userId_track_active_idx" ON "Watchlist"("userId", "track", "active");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
