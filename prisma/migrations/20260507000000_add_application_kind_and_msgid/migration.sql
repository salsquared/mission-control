-- AlterTable
ALTER TABLE "Application" ADD COLUMN "kind" TEXT;
ALTER TABLE "Application" ADD COLUMN "lastEmailMsgId" TEXT;

-- CreateIndex
CREATE INDEX "Application_userId_kind_idx" ON "Application"("userId", "kind");
