-- CreateTable
CREATE TABLE "CryptoPrice" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "coinId" TEXT NOT NULL,
    "price" REAL NOT NULL,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "SavedPaper" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "paperId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "authors" TEXT NOT NULL,
    "publishedAt" DATETIME NOT NULL,
    "topic" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "SelectedHistoricalPaper" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "paperId" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "weekStart" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "SelectedReviewPaper" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "paperId" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "weekStart" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "GlobalSetting" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'global',
    "data" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "refresh_token" TEXT,
    "access_token" TEXT,
    "expires_at" INTEGER,
    "token_type" TEXT,
    "scope" TEXT,
    "id_token" TEXT,
    "session_state" TEXT,
    CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionToken" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expires" DATETIME NOT NULL,
    CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT,
    "email" TEXT,
    "emailVerified" DATETIME,
    "image" TEXT
);

-- CreateTable
CREATE TABLE "VerificationToken" (
    "identifier" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Application" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "role" TEXT,
    "status" TEXT NOT NULL,
    "nextSteps" TEXT,
    "dateApplied" DATETIME,
    "lastUpdateAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Application_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "text" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "priority" TEXT,
    "project" TEXT,
    "dueDate" DATETIME,
    "filePath" TEXT NOT NULL,
    "lineNumber" INTEGER NOT NULL,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "parentId" TEXT,
    CONSTRAINT "Task_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Task" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "LifeGoal" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "text" TEXT NOT NULL,
    "estimatedTime" TEXT,
    "completed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "CacheEntry" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "data" TEXT NOT NULL,
    "expiry" DATETIME NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "CryptoPrice_coinId_timestamp_idx" ON "CryptoPrice"("coinId", "timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "SavedPaper_paperId_key" ON "SavedPaper"("paperId");

-- CreateIndex
CREATE INDEX "SavedPaper_status_topic_idx" ON "SavedPaper"("status", "topic");

-- CreateIndex
CREATE INDEX "SelectedHistoricalPaper_topic_weekStart_idx" ON "SelectedHistoricalPaper"("topic", "weekStart");

-- CreateIndex
CREATE UNIQUE INDEX "SelectedHistoricalPaper_paperId_topic_key" ON "SelectedHistoricalPaper"("paperId", "topic");

-- CreateIndex
CREATE INDEX "SelectedReviewPaper_topic_weekStart_idx" ON "SelectedReviewPaper"("topic", "weekStart");

-- CreateIndex
CREATE UNIQUE INDEX "SelectedReviewPaper_paperId_topic_key" ON "SelectedReviewPaper"("paperId", "topic");

-- CreateIndex
CREATE UNIQUE INDEX "Account_provider_providerAccountId_key" ON "Account"("provider", "providerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_sessionToken_key" ON "Session"("sessionToken");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_token_key" ON "VerificationToken"("token");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_identifier_token_key" ON "VerificationToken"("identifier", "token");

-- CreateIndex
CREATE INDEX "Application_userId_status_idx" ON "Application"("userId", "status");

-- CreateIndex
CREATE INDEX "Task_status_idx" ON "Task"("status");

-- CreateIndex
CREATE INDEX "Task_filePath_idx" ON "Task"("filePath");

-- CreateIndex
CREATE INDEX "CacheEntry_expiry_idx" ON "CacheEntry"("expiry");
