-- CreateTable
CREATE TABLE "ResumeUpload" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "rawText" TEXT NOT NULL,
    "parsedJson" TEXT NOT NULL,
    "artifactPath" TEXT,
    "importBatchId" TEXT,
    "uploadedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ResumeUpload_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "ResumeUpload_userId_uploadedAt_idx" ON "ResumeUpload"("userId", "uploadedAt");
