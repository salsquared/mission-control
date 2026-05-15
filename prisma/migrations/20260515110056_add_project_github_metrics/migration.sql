-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Project" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "profileId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "repoUrl" TEXT,
    "liveUrl" TEXT,
    "bullets" TEXT NOT NULL DEFAULT '[]',
    "metrics" TEXT,
    "githubRepo" TEXT,
    "portfolio" BOOLEAN NOT NULL DEFAULT false,
    "metricsUpdatedAt" DATETIME,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Project_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Project" ("bullets", "createdAt", "description", "id", "liveUrl", "metrics", "name", "position", "profileId", "repoUrl", "updatedAt") SELECT "bullets", "createdAt", "description", "id", "liveUrl", "metrics", "name", "position", "profileId", "repoUrl", "updatedAt" FROM "Project";
DROP TABLE "Project";
ALTER TABLE "new_Project" RENAME TO "Project";
CREATE INDEX "Project_profileId_position_idx" ON "Project"("profileId", "position");
CREATE INDEX "Project_portfolio_metricsUpdatedAt_idx" ON "Project"("portfolio", "metricsUpdatedAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
