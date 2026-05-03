/*
  Warnings:

  - You are about to drop the column `data` on the `GlobalSetting` table. All the data in the column will be lost.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_GlobalSetting" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'global',
    "isDarkMode" BOOLEAN NOT NULL DEFAULT true,
    "viewHuesEnabled" BOOLEAN NOT NULL DEFAULT true,
    "viewHues" TEXT NOT NULL DEFAULT '{}',
    "dashOrder" TEXT NOT NULL DEFAULT '[]',
    "dashTitles" TEXT NOT NULL DEFAULT '{}',
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_GlobalSetting" ("dashOrder", "dashTitles", "id", "isDarkMode", "updatedAt", "viewHues", "viewHuesEnabled") SELECT coalesce("dashOrder", '[]') AS "dashOrder", coalesce("dashTitles", '{}') AS "dashTitles", "id", coalesce("isDarkMode", true) AS "isDarkMode", "updatedAt", coalesce("viewHues", '{}') AS "viewHues", coalesce("viewHuesEnabled", true) AS "viewHuesEnabled" FROM "GlobalSetting";
DROP TABLE "GlobalSetting";
ALTER TABLE "new_GlobalSetting" RENAME TO "GlobalSetting";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
