-- CreateTable
CREATE TABLE "GeneratedResume" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "applicationId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "postingInput" TEXT NOT NULL,
    "profileSnapshot" TEXT NOT NULL,
    "selections" TEXT NOT NULL,
    "templateKey" TEXT NOT NULL DEFAULT 'ats-plain',
    "format" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "artifactPath" TEXT,
    "error" TEXT,
    CONSTRAINT "GeneratedResume_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "GeneratedResume_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "GeneratedResume_userId_createdAt_idx" ON "GeneratedResume"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "GeneratedResume_applicationId_idx" ON "GeneratedResume"("applicationId");
