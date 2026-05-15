-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Notification" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "tier" TEXT NOT NULL DEFAULT 'low',
    "title" TEXT NOT NULL,
    "body" TEXT,
    "payload" TEXT NOT NULL,
    "channels" TEXT NOT NULL DEFAULT 'in_app',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readAt" DATETIME,
    "dismissedAt" DATETIME,
    "emailSentAt" DATETIME,
    "emailError" TEXT,
    CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Notification" ("body", "channels", "createdAt", "dismissedAt", "emailError", "emailSentAt", "id", "kind", "payload", "readAt", "title", "userId") SELECT "body", "channels", "createdAt", "dismissedAt", "emailError", "emailSentAt", "id", "kind", "payload", "readAt", "title", "userId" FROM "Notification";
DROP TABLE "Notification";
ALTER TABLE "new_Notification" RENAME TO "Notification";
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");
CREATE INDEX "Notification_userId_readAt_idx" ON "Notification"("userId", "readAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
