-- AlterTable
ALTER TABLE "ApplicationEvent" ADD COLUMN "gcalSyncedAt" DATETIME;
ALTER TABLE "ApplicationEvent" ADD COLUMN "notifiedAt" DATETIME;

-- AlterTable
ALTER TABLE "User" ADD COLUMN "lastSyncedHistoryId" TEXT;

-- CreateTable
CREATE TABLE "WebhookDelivery" (
    "messageId" TEXT NOT NULL PRIMARY KEY,
    "source" TEXT NOT NULL,
    "receivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "WebhookDelivery_receivedAt_idx" ON "WebhookDelivery"("receivedAt");
