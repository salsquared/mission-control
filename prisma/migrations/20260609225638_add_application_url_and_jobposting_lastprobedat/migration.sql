-- AlterTable
ALTER TABLE "Application" ADD COLUMN "url" TEXT;

-- AlterTable
ALTER TABLE "JobPosting" ADD COLUMN "lastProbedAt" DATETIME;

-- CreateIndex
CREATE INDEX "JobPosting_status_lastProbedAt_idx" ON "JobPosting"("status", "lastProbedAt");
