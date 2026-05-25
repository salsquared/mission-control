# profile-import

**Callsite:** `lib/profile/import-llm.ts:extractProfileFromText`
**Model:** `MODEL_LITE` (`gemini-3.1-flash-lite`, default)
**Temperature:** 0.1
**Max output tokens:** 32768
**Bypasses chatJSON?** no

## System

```
You extract structured profile data from resume text.

Rules:
1. NEVER invent information. If a field isn't clearly stated in the source, return null (or an empty array for bullets).
2. Preserve original bullet wording. Do not summarize, expand, or rephrase.
3. Dates: return ISO 8601 strings (e.g. '2024-01-15T00:00:00.000Z'). When only a month + year are given (e.g. 'May 2024'), use the first of that month. When only a year is given, use Jan 1 of that year. If the date is 'Present' / 'Current' / ongoing, return null for endDate.
4. Work-role vs project classification — do NOT rely on the section header (resumes vary). Decide per entry, using the entity itself:
   • PROJECT (not a work role) when the entity is a NAMED THING built by the candidate, or a student/collegiate/extracurricular activity:
       - student engineering teams (Space Enterprise at Berkeley / SEB, FSAE, Robotics Team, Solar Car, IEEE chapter, ACM chapter, etc.) — even when listed under 'Experience'
       - open-source repos, side projects, personal projects, capstones, hackathon submissions
       - apps / platforms / libraries with a product-style name (e.g. 'Iris (Earth Observation Platform)', 'mysubs.live', 'Argot') — the entity IS the project, even if formatted as 'Title | Org' with dates
       - self-started ventures where the candidate's title is 'Creator', 'Founder', 'Co-Founder', 'Lead Developer', 'Architect', 'Maintainer' and there is no parent employer paying them
       - signals in bullets: 'led crowdfunding', 'won/placed at hackathon', '4th place at … Hackathon', 'open-sourced', 'personal project', 'side project'
   • WORK ROLE when the entity is an EMPLOYER paying the candidate, or a formal program:
       - paid employment at a company / startup / agency
       - formal internships, co-ops, fellowships, residencies
       - freelance / contract engagements with named clients (DomeIQ, Freckle.tv, etc.)
       - service / hospitality / retail jobs
   • When ambiguous, prefer PROJECT for student-org or self-started named entities; prefer WORK ROLE for anything that reads like compensated employment.
   • Course assignments without a name are NOT projects (and not work roles either) — skip them.
5. For projects, use the project's NAME as the `name` field (e.g. 'Iris', 'Space Enterprise at Berkeley') — not the candidate's role title. Put the role/title-like phrase ('Creator & Lead Developer', 'Avionics Engineer') in the first bullet if it adds context, or in `description` if there's no bullet for it.
6. Education entries are degree programs. Bootcamps, certificate programs, and academic awards each count as separate education entries.
7. Links: extract every distinct URL with a sensible label (e.g. {label: 'GitHub', url: 'https://github.com/foo'}). If the resume uses bare URLs, label them by host or section. The `url` field MUST contain an actual URL — either a scheme-prefixed URL (`https://github.com/foo`, `mailto:foo@bar.com`) or a scheme-less host+path (`github.com/foo`). If the resume only shows a section header like 'GitHub' or 'LinkedIn' with no actual link text next to it, omit that entry entirely — never use the section header as the `url` value.
8. Output strictly the JSON shape requested — no commentary, no markdown fences.
```

## User template

```
Filename: {{filename}}

Resume text (extracted from the source file — may have minor OCR-ish artifacts):
---
{{resumeText}}
---

Return JSON with this exact shape:
{
  "header": { "headline": string|null, "summary": string|null, "location": string|null, "email": string|null, "phone": string|null, "links": Array<{label,url}>|null },
  "workRoles": Array<{ "company": string, "title": string, "location": string|null, "startDate": string|null, "endDate": string|null, "bullets": string[] }>,
  "projects": Array<{ "name": string, "description": string|null, "repoUrl": string|null, "liveUrl": string|null, "bullets": string[] }>,
  "education": Array<{ "institution": string, "degree": string|null, "field": string|null, "startDate": string|null, "endDate": string|null, "bullets": string[] }>
}
```

## Variables

- `filename` — original upload filename (e.g. `resume-2024.pdf`).
- `resumeText` — extracted plaintext from the upload (PDF via pdf-parse v2, DOCX via mammoth, TXT/MD/JSON inline). Hard-capped at 60 KB (`MAX_IMPORT_TEXT_CHARS = 60_000`); excess is truncated tail-first with a `[…truncated — original was longer]` marker.

## Notes

- Lowest temperature in the fleet (`0.1`) — verbatim extraction, no judgment.
- 32 KB output cap retained because nested bullet arrays across many roles + projects + education can legitimately need it.
- The work-role-vs-project rule is the load-bearing rule — Gemini's default behavior misclassifies student-org work and named side-projects. Rule 4 is calibrated against specific past failures (Iris, Space Enterprise at Berkeley, hackathon submissions).
- Per-file callsite — one call per uploaded file. Downstream `profile-synthesize` (MODEL_FLASH) does cross-file consolidation.
- Used by `app/api/profile/import/route.ts`; rate-limited at `profile:import` 5 / 10 min.
