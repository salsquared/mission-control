-- Story S7.14 follow-up — drop the legacy `summary` column from Profile.
-- Tagline (added in `20260526032940_add_profile_tagline`) replaces it as
-- the only one-line pitch on the resume. Existing summary content is
-- discarded by this migration; the column has been confirmed unused by
-- the resume rendering pipeline post-M7.9.
--
-- SQLite requires the recreate-table dance to drop a column in older
-- versions; Prisma's diff engine does the same for the migration. Manual
-- migration here (instead of `prisma migrate dev`) because the
-- interactive data-loss prompt blocks non-interactive sessions.
PRAGMA foreign_keys=OFF;

CREATE TABLE "new_Profile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "headline" TEXT,
    "tagline" TEXT,
    "location" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "links" TEXT,
    "skills" TEXT,
    "hobbies" TEXT,
    "languages" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Profile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "new_Profile" ("id", "userId", "headline", "tagline", "location", "email", "phone", "links", "skills", "hobbies", "languages", "createdAt", "updatedAt")
SELECT "id", "userId", "headline", "tagline", "location", "email", "phone", "links", "skills", "hobbies", "languages", "createdAt", "updatedAt"
FROM "Profile";

DROP TABLE "Profile";
ALTER TABLE "new_Profile" RENAME TO "Profile";

CREATE UNIQUE INDEX "Profile_userId_key" ON "Profile"("userId");

PRAGMA foreign_keys=ON;
