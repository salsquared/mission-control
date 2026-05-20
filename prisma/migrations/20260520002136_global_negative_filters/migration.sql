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
    "globalNegativeFilters" TEXT NOT NULL DEFAULT '[]',
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_GlobalSetting" ("dashOrder", "dashTitles", "id", "isDarkMode", "updatedAt", "version", "viewHues", "viewHuesEnabled") SELECT "dashOrder", "dashTitles", "id", "isDarkMode", "updatedAt", "version", "viewHues", "viewHuesEnabled" FROM "GlobalSetting";
DROP TABLE "GlobalSetting";
ALTER TABLE "new_GlobalSetting" RENAME TO "GlobalSetting";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
