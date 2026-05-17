-- PB-8: dedupKey @unique on Notification. Concurrent dispatches with the same
-- key race on the constraint; the loser catches P2002 and no-ops. Nullable so
-- legacy + test-fixture rows are unaffected (SQLite allows multiple NULLs in
-- a unique column).
ALTER TABLE "Notification" ADD COLUMN "dedupKey" TEXT;
CREATE UNIQUE INDEX "Notification_dedupKey_key" ON "Notification"("dedupKey");
