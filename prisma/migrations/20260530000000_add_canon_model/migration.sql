-- CreateTable
CREATE TABLE "Canon" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "track" TEXT NOT NULL,
    "description" TEXT,
    "keywords" TEXT NOT NULL DEFAULT '',
    "onePage" BOOLEAN NOT NULL DEFAULT true,
    "pinnedEntityIds" TEXT,
    "sectionOrder" TEXT,
    "currentResumeId" TEXT,
    "resumeStale" BOOLEAN NOT NULL DEFAULT true,
    "resumeEntityIds" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Canon_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Application" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "normalizedCompany" TEXT,
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
INSERT INTO "new_Application" ("company", "createdAt", "dateApplied", "decisionDeadline", "id", "kind", "lastEmailMsgId", "lastUpdateAt", "nextSteps", "normalizedCompany", "normalizedRole", "postingId", "role", "senderDomain", "sourceJobId", "status", "track", "updatedAt", "userId") SELECT "company", "createdAt", "dateApplied", "decisionDeadline", "id", "kind", "lastEmailMsgId", "lastUpdateAt", "nextSteps", "normalizedCompany", "normalizedRole", "postingId", "role", "senderDomain", "sourceJobId", "status", "track", "updatedAt", "userId" FROM "Application";
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
CREATE TABLE "new_GeneratedResume" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "applicationId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "postingInput" TEXT NOT NULL,
    "postingTitle" TEXT,
    "postingCompany" TEXT,
    "tagline" TEXT,
    "profileSnapshot" TEXT NOT NULL,
    "selections" TEXT NOT NULL,
    "skillsGap" TEXT,
    "templateKey" TEXT NOT NULL DEFAULT 'ats-plain',
    "format" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "artifactPath" TEXT,
    "error" TEXT,
    "canonId" TEXT,
    "isCanonical" BOOLEAN NOT NULL DEFAULT false,
    "canonVersion" INTEGER,
    CONSTRAINT "GeneratedResume_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "GeneratedResume_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "GeneratedResume_canonId_fkey" FOREIGN KEY ("canonId") REFERENCES "Canon" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_GeneratedResume" ("applicationId", "artifactPath", "createdAt", "error", "format", "id", "postingCompany", "postingInput", "postingTitle", "profileSnapshot", "selections", "skillsGap", "status", "tagline", "templateKey", "userId") SELECT "applicationId", "artifactPath", "createdAt", "error", "format", "id", "postingCompany", "postingInput", "postingTitle", "profileSnapshot", "selections", "skillsGap", "status", "tagline", "templateKey", "userId" FROM "GeneratedResume";
DROP TABLE "GeneratedResume";
ALTER TABLE "new_GeneratedResume" RENAME TO "GeneratedResume";
CREATE INDEX "GeneratedResume_userId_createdAt_idx" ON "GeneratedResume"("userId", "createdAt");
CREATE INDEX "GeneratedResume_applicationId_idx" ON "GeneratedResume"("applicationId");
CREATE INDEX "GeneratedResume_canonId_canonVersion_idx" ON "GeneratedResume"("canonId", "canonVersion");
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
    "canonId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Watchlist_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Watchlist_canonId_fkey" FOREIGN KEY ("canonId") REFERENCES "Canon" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Watchlist" ("active", "config", "createdAt", "directoryKey", "id", "kind", "lastDigestAt", "lastError", "lastRunAt", "lastSuccessAt", "name", "negativeFilters", "notificationMode", "scheduleMinutes", "track", "updatedAt", "userId") SELECT "active", "config", "createdAt", "directoryKey", "id", "kind", "lastDigestAt", "lastError", "lastRunAt", "lastSuccessAt", "name", "negativeFilters", "notificationMode", "scheduleMinutes", "track", "updatedAt", "userId" FROM "Watchlist";
DROP TABLE "Watchlist";
ALTER TABLE "new_Watchlist" RENAME TO "Watchlist";
CREATE INDEX "Watchlist_userId_active_idx" ON "Watchlist"("userId", "active");
CREATE INDEX "Watchlist_userId_track_active_idx" ON "Watchlist"("userId", "track", "active");
CREATE INDEX "Watchlist_canonId_idx" ON "Watchlist"("canonId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "Canon_userId_track_active_idx" ON "Canon"("userId", "track", "active");

-- CreateIndex
CREATE UNIQUE INDEX "Canon_userId_slug_key" ON "Canon"("userId", "slug");

