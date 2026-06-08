-- AlterTable
ALTER TABLE "Notification" ADD COLUMN "emailMessageId" TEXT;
ALTER TABLE "Notification" ADD COLUMN "scopeKey" TEXT;

-- CreateIndex
CREATE INDEX "Notification_userId_scopeKey_createdAt_idx" ON "Notification"("userId", "scopeKey", "createdAt");
