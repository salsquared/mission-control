-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Application" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "role" TEXT,
    "status" TEXT NOT NULL,
    "kind" TEXT,
    "nextSteps" TEXT,
    "dateApplied" DATETIME,
    "lastEmailMsgId" TEXT,
    "postingId" TEXT,
    "lastUpdateAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Application_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Application_postingId_fkey" FOREIGN KEY ("postingId") REFERENCES "JobPosting" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Application" ("company", "createdAt", "dateApplied", "id", "kind", "lastEmailMsgId", "lastUpdateAt", "nextSteps", "role", "status", "updatedAt", "userId") SELECT "company", "createdAt", "dateApplied", "id", "kind", "lastEmailMsgId", "lastUpdateAt", "nextSteps", "role", "status", "updatedAt", "userId" FROM "Application";
DROP TABLE "Application";
ALTER TABLE "new_Application" RENAME TO "Application";
CREATE UNIQUE INDEX "Application_postingId_key" ON "Application"("postingId");
CREATE INDEX "Application_userId_status_idx" ON "Application"("userId", "status");
CREATE INDEX "Application_userId_kind_idx" ON "Application"("userId", "kind");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
