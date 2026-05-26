-- Drop the README columns added by 20260526051000_restore_project_readme.
-- The README ingest path is being retired: bullet-assist and resume-rewrite
-- no longer inject README excerpts into their prompts (signal-to-token ratio
-- was poor), and the scheduler job + GitHub fetcher have been removed in the
-- same change. The columns become dead weight, so drop them.
ALTER TABLE "Project" DROP COLUMN "readme";
ALTER TABLE "Project" DROP COLUMN "readmeUpdatedAt";
