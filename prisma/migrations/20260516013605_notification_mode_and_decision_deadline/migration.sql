-- AlterTable
ALTER TABLE "Application" ADD COLUMN "decisionDeadline" DATETIME;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Watchlist" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "config" TEXT NOT NULL,
    "negativeFilters" TEXT,
    "notificationMode" TEXT NOT NULL DEFAULT 'each',
    "lastDigestAt" DATETIME,
    "scheduleMinutes" INTEGER NOT NULL DEFAULT 30,
    "lastRunAt" DATETIME,
    "lastSuccessAt" DATETIME,
    "lastError" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Watchlist_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Watchlist" ("active", "config", "createdAt", "id", "kind", "lastError", "lastRunAt", "lastSuccessAt", "name", "negativeFilters", "scheduleMinutes", "updatedAt", "userId") SELECT "active", "config", "createdAt", "id", "kind", "lastError", "lastRunAt", "lastSuccessAt", "name", "negativeFilters", "scheduleMinutes", "updatedAt", "userId" FROM "Watchlist";
DROP TABLE "Watchlist";
ALTER TABLE "new_Watchlist" RENAME TO "Watchlist";
CREATE INDEX "Watchlist_userId_active_idx" ON "Watchlist"("userId", "active");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
