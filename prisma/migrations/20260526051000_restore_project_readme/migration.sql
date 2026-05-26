-- Re-add the README columns dropped by 20260526050000_drop_project_github_metrics.
-- The README ingest is preserved as LLM-grounding context for bullet-assist
-- and resume-rewrite; what was dropped (and stays dropped) is the user-facing
-- portfolio toggle, the owner/repo input field, and the metric-deltas
-- notifications path. The README scheduler now derives owner/repo by parsing
-- Project.repoUrl when it's a github.com URL — no separate `githubRepo`
-- column required.
ALTER TABLE "Project" ADD COLUMN "readme" TEXT;
ALTER TABLE "Project" ADD COLUMN "readmeUpdatedAt" DATETIME;
