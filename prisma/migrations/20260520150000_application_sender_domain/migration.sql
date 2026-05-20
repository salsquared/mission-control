-- Layered application dedup (2026-05-20 CSULB drift fix). Adds a sender-domain
-- column + secondary index so ingest can match emails to an existing
-- Application when the LLM classifier drifts on the company name across
-- multiple emails from the same school/employer.
ALTER TABLE "Application" ADD COLUMN "senderDomain" TEXT;
CREATE INDEX "Application_userId_senderDomain_idx" ON "Application"("userId", "senderDomain");
