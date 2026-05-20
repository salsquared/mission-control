-- CreateTable
CREATE TABLE "BlacklistedCompany" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BlacklistedCompany_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "BlacklistedCompany_userId_idx" ON "BlacklistedCompany"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "BlacklistedCompany_userId_normalizedName_key" ON "BlacklistedCompany"("userId", "normalizedName");
