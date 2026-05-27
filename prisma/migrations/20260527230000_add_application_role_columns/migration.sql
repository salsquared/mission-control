-- 2026-05-27 multi-role-per-company (Phase 1 of 2). Adds the new nullable
-- columns. The unique-key swap lives in the follow-up migration so the
-- operator can backfill + audit (scripts/backfill-normalized-role.ts) and
-- resolve any collisions BEFORE CREATE UNIQUE INDEX fires on a dirty table.
ALTER TABLE "Application" ADD COLUMN "normalizedRole" TEXT;
ALTER TABLE "Application" ADD COLUMN "sourceJobId" TEXT;
