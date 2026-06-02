-- 2026-06-01: add Application.location.
--
-- Free-form job/role location (e.g. "Long Beach, CA" / "Remote") surfaced on
-- the kanban card and editable from the detail sidebar. Populated from
-- JobPosting.location at track-as-application time; nullable for Gmail-ingested
-- and legacy rows. Purely informational — no normalization / dedup role — so
-- this is a plain additive column with no backfill.
-- AlterTable
ALTER TABLE "Application" ADD COLUMN "location" TEXT;
