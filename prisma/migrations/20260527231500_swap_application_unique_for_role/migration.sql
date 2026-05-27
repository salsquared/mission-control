-- 2026-05-27 multi-role-per-company (Phase 2 of 2). Swaps the dedup unique
-- key so two roles at the same employer on the same kanban can coexist as
-- separate Application rows. Add the userId+sourceJobId lookup index used by
-- track-as-application.ts as a high-precision dedup hint.
--
-- Pre-req: scripts/backfill-normalized-role.ts run on this DB with the
-- collision audit reporting ✓. Without that, CREATE UNIQUE INDEX below
-- will fail on any colliding row group.
DROP INDEX "Application_userId_normalizedCompany_track_key";
CREATE UNIQUE INDEX "Application_userId_normalizedCompany_normalizedRole_track_key" ON "Application"("userId", "normalizedCompany", "normalizedRole", "track");
CREATE INDEX "Application_userId_sourceJobId_idx" ON "Application"("userId", "sourceJobId");
