-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_GlobalSetting" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'global',
    "data" TEXT,
    "isDarkMode" BOOLEAN DEFAULT true,
    "viewHuesEnabled" BOOLEAN DEFAULT true,
    "viewHues" TEXT,
    "dashOrder" TEXT,
    "dashTitles" TEXT,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_GlobalSetting" ("data", "id", "updatedAt") SELECT "data", "id", "updatedAt" FROM "GlobalSetting";
DROP TABLE "GlobalSetting";
ALTER TABLE "new_GlobalSetting" RENAME TO "GlobalSetting";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
