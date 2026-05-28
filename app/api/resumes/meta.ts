import type { ApiMeta } from '@/lib/api-docs/meta';

export const apiMeta: ApiMeta = {
    purpose: "Lists the session user's previously generated resumes (GET) or runs the full resume-gen pipeline against a job posting and streams a tailored PDF/DOCX (POST).",
    external: ["Gemini"],
    notes: "POST is a multi-stage pipeline (parse posting → auto-tag → select → scratchpad-synth → rewrite → tailor tagline → render); fetches the posting URL, broadcasts GeneratedResume upsert, and is rate-limited at 5/10min.",
};
