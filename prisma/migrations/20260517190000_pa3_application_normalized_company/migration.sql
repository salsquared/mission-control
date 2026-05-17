-- PA-3: race-safe duplicate-application prevention. New normalizedCompany
-- column, @@unique([userId, normalizedCompany]). SQLite allows multiple
-- NULLs in a unique compound so legacy rows stay unconstrained until backfill.
ALTER TABLE "Application" ADD COLUMN "normalizedCompany" TEXT;
CREATE UNIQUE INDEX "Application_userId_normalizedCompany_key" ON "Application"("userId", "normalizedCompany");
