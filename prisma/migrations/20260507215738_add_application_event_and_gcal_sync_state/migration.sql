-- CreateTable
CREATE TABLE "ApplicationEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "applicationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "occurredAt" DATETIME NOT NULL,
    "scheduledAt" DATETIME,
    "endsAt" DATETIME,
    "fromStatus" TEXT,
    "toStatus" TEXT,
    "notes" TEXT,
    "emailMsgId" TEXT,
    "gcalEventId" TEXT,
    "gcalUpdatedAt" DATETIME,
    "syncSource" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ApplicationEvent_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "GcalSyncState" (
    "userId" TEXT NOT NULL PRIMARY KEY,
    "syncToken" TEXT,
    "lastSyncedAt" DATETIME NOT NULL,
    CONSTRAINT "GcalSyncState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "ApplicationEvent_applicationId_occurredAt_idx" ON "ApplicationEvent"("applicationId", "occurredAt");

-- CreateIndex
CREATE INDEX "ApplicationEvent_scheduledAt_idx" ON "ApplicationEvent"("scheduledAt");

-- CreateIndex
CREATE INDEX "ApplicationEvent_gcalEventId_idx" ON "ApplicationEvent"("gcalEventId");

-- CreateIndex
CREATE UNIQUE INDEX "ApplicationEvent_applicationId_emailMsgId_kind_key" ON "ApplicationEvent"("applicationId", "emailMsgId", "kind");
