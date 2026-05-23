-- AlterTable
ALTER TABLE "JobPosting" ADD COLUMN "compensationCadence" TEXT;
ALTER TABLE "JobPosting" ADD COLUMN "compensationCurrency" TEXT;
ALTER TABLE "JobPosting" ADD COLUMN "compensationMax" INTEGER;
ALTER TABLE "JobPosting" ADD COLUMN "compensationMin" INTEGER;
