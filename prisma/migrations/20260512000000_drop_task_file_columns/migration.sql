-- Drop filePath / lineNumber; introduce `position` (backfilled from old lineNumber).
-- Part of the cutover that makes the DB the source of truth for tasks
-- (docs/todo.md is no longer a synced surface).

PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

CREATE TABLE "new_Task" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "text" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "priority" TEXT,
    "project" TEXT,
    "dueDate" DATETIME,
    "position" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "parentId" TEXT,
    FOREIGN KEY ("parentId") REFERENCES "Task" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

INSERT INTO "new_Task" ("id", "text", "status", "priority", "project", "dueDate", "position", "notes", "createdAt", "updatedAt", "parentId")
SELECT "id", "text", "status", "priority", "project", "dueDate", "lineNumber", "notes", "createdAt", "updatedAt", "parentId" FROM "Task";

DROP TABLE "Task";
ALTER TABLE "new_Task" RENAME TO "Task";

CREATE INDEX "Task_status_idx" ON "Task"("status");
CREATE INDEX "Task_position_idx" ON "Task"("position");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
