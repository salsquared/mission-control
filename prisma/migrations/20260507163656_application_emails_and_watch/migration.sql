-- AlterTable
ALTER TABLE "Application" ADD COLUMN "nextStepAt" DATETIME;

-- CreateTable
CREATE TABLE "ApplicationEmail" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "applicationId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "threadId" TEXT,
    "subject" TEXT NOT NULL,
    "fromAddress" TEXT NOT NULL,
    "receivedAt" DATETIME NOT NULL,
    "snippet" TEXT,
    "parsedStatus" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ApplicationEmail_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "GmailWatch" (
    "userId" TEXT NOT NULL PRIMARY KEY,
    "historyId" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "installedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "ApplicationEmail_messageId_key" ON "ApplicationEmail"("messageId");

-- CreateIndex
CREATE INDEX "ApplicationEmail_applicationId_receivedAt_idx" ON "ApplicationEmail"("applicationId", "receivedAt");
