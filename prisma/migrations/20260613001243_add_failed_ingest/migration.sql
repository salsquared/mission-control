-- CreateTable
CREATE TABLE "FailedIngest" (
    "msgId" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "firstFailedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT NOT NULL,
    "nextRetryAt" DATETIME NOT NULL,
    CONSTRAINT "FailedIngest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "FailedIngest_nextRetryAt_idx" ON "FailedIngest"("nextRetryAt");
