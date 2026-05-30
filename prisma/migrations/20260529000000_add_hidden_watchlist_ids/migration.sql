-- 2026-05-29: cross-device watchlist visibility. The eye toggle on each
-- WatchlistsCard row hides that watchlist's postings from the New/Side
-- postings feed; the hidden-ID list is synced via /api/settings so all of a
-- single user's devices show the same feed. Stored as a JSON string[] on the
-- shared GlobalSetting row, alongside globalNegativeFilters.
ALTER TABLE "GlobalSetting" ADD COLUMN "hiddenWatchlistIds" TEXT NOT NULL DEFAULT '[]';
