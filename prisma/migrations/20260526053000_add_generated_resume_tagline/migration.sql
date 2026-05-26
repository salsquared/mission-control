-- Add posting-tailored tagline snapshot column. LLM-generated at resume
-- gen time by the new `resume-tagline` callsite (grounded on profile +
-- parsed posting) so a single user can pitch differently per job — e.g.
-- "Applied Math student at CSULB looking for work" for a security-guard
-- posting vs. "Software engineer focused on…" for an SWE posting. NULL on
-- pre-existing rows; ats-plain template falls back to profile.tagline in
-- that case so historical resumes still render with a subtitle.
ALTER TABLE "GeneratedResume" ADD COLUMN "tagline" TEXT;
