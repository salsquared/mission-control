-- AlterTable
ALTER TABLE "SelectedHistoricalPaper" ADD COLUMN "author" TEXT;
ALTER TABLE "SelectedHistoricalPaper" ADD COLUMN "citationCount" INTEGER;
ALTER TABLE "SelectedHistoricalPaper" ADD COLUMN "publishedAt" DATETIME;
ALTER TABLE "SelectedHistoricalPaper" ADD COLUMN "summary" TEXT;
ALTER TABLE "SelectedHistoricalPaper" ADD COLUMN "title" TEXT;
ALTER TABLE "SelectedHistoricalPaper" ADD COLUMN "url" TEXT;

-- AlterTable
ALTER TABLE "SelectedReviewPaper" ADD COLUMN "author" TEXT;
ALTER TABLE "SelectedReviewPaper" ADD COLUMN "citationCount" INTEGER;
ALTER TABLE "SelectedReviewPaper" ADD COLUMN "publishedAt" DATETIME;
ALTER TABLE "SelectedReviewPaper" ADD COLUMN "summary" TEXT;
ALTER TABLE "SelectedReviewPaper" ADD COLUMN "title" TEXT;
ALTER TABLE "SelectedReviewPaper" ADD COLUMN "url" TEXT;
