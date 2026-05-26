-- Drop the M9 GitHub-metrics columns from Project: metrics, githubRepo,
-- portfolio, metricsUpdatedAt, readme, readmeUpdatedAt.
--
-- The feature surface (portfolio toggle + owner/repo input + README ingest +
-- star/commit milestone notifications) was removed from the UI; the
-- supporting scheduler job (scheduler/jobs/github-metrics.ts), public-API
-- fetcher (lib/fetchers/github-public-fetcher.ts), and metric-deltas helper
-- (lib/profile/metric-deltas.ts) were deleted in the same change.
--
-- SQLite recreate-table dance (same pattern as
-- 20260526040000_drop_profile_summary). Manual migration instead of
-- `prisma migrate dev` to avoid the interactive data-loss prompt.
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
    "scratchpad" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Project_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "new_Project" ("id", "profileId", "name", "description", "repoUrl", "liveUrl", "bullets", "scratchpad", "position", "createdAt", "updatedAt")
SELECT "id", "profileId", "name", "description", "repoUrl", "liveUrl", "bullets", "scratchpad", "position", "createdAt", "updatedAt"
FROM "Project";

DROP TABLE "Project";
ALTER TABLE "new_Project" RENAME TO "Project";

CREATE INDEX "Project_profileId_position_idx" ON "Project"("profileId", "position");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
