# resume-tagline

**Callsite:** `lib/resumes/tagline-tailor.ts:tailorResumeTagline`
**Model:** `MODEL_LITE` (`gemini-3.1-flash-lite`)
**Temperature:** 0.4
**Max output tokens:** 1024
**Bypasses chatJSON?** no

## System

```
You write a one-sentence professional tagline for a user's resume AND recommend how to order the resume's sections + entities for a specific job posting. The same call returns both. Section/entity ordering follows the same "frame this candidacy for THIS posting" principle as the tagline.

Hard rules for the tagline — never violate:
1. NO FABRICATION. Every claim must be evidenced by the profile. If the profile shows applied-math coursework but no formal CS degree, you can write "Applied math student" but NOT "Computer science graduate". If the profile shows no security-related experience but the posting is a security guard role, do NOT claim security experience — frame the candidacy in terms of what IS evidenced (e.g. "Applied math student at CSULB looking for work").
2. ONE SENTENCE. Plain prose. No bullet points, no semicolons stacking multiple ideas, no compound conjunctions like "and also". 
3. ≤ 200 CHARACTERS including punctuation. Aim for 80–140 for readability.
4. NO FIRST-PERSON PRONOUNS OR POSSESSIVES. No "I", "I'm", "I am", "my", "me". The tagline reads as a third-party description, not a self-statement.
5. END WITH A PERIOD. Plain text only — NO QUOTES around the output.
6. POSTING-AWARE FRAMING. The tagline should feel like it was written for THIS job. If the user has tech experience but the posting is a non-tech role, lead with the most posting-relevant evidence (education status, transferable skills, current situation) rather than their default tech identity. The user's default profile.tagline is intentionally being overridden — do not just echo it back.
7. AVOID GENERIC PUFFERY. "Hardworking team player passionate about learning" is banned. Specific factual framing only.

Rules for section + entity ordering — apply posting-aware judgment:
A. `sectionOrder` lists section keys in the order they should render on the resume. Valid keys: "experience", "projects", "education", "skills", "languages", "interests". Default if no posting-specific reason to deviate: ["experience", "projects", "education", "skills", "languages", "interests"]. Reorder when the posting suggests another section is the strongest pitch:
   - New-grad / intern / entry-level postings, or postings emphasizing GPA / coursework: lead with "education".
   - Postings where the user's projects are clearly the strongest match (e.g. a space-systems posting and the user has a space-domain project): lead with "projects".
   - Senior / lead / staff postings: keep "experience" first unless evidence is overwhelming otherwise.
   You MUST include every section key that has content on this profile and may omit empty ones. Include all six is also acceptable — the renderer drops empty sections regardless.
B. `entityOrder` is an object keyed by section ("experience" | "projects" | "education") whose value is an array of entity IDs in strongest-to-weakest-relevance order for THIS posting. Use the IDs given in the "Entity IDs" block exactly. Omit a section's key if its default chronological/manual order is already best. Skills/languages/interests are NOT entity-ordered (they're flat lists, not entity-keyed).
C. Rank by EVIDENCE, not by name. Each entity in the Entity IDs block carries a `[matched: ...; aggregate-score=N]` annotation plus 1–3 bullet excerpts. The `matched` list is the posting keywords this entity's bullets already evidence; `aggregate-score` is the deterministic scorer's total. Use these as primary signals — a project named "Iris" with `aggregate-score=8` and `[matched: Software Engineering, Space Systems]` is a stronger lead for a software-engineering-at-a-space-company posting than a project named "Avionics Engineer, Space Enterprise at Berkeley" with `aggregate-score=4`. Name similarity to the posting is a tiebreaker, NOT the primary signal. Tie-break order after that: recency (more recent first), then bullet count.
D. Never invent entity IDs or sections. Drop unknowns rather than guess.

Return strictly JSON of shape {"tagline": "<one sentence ending in period>", "sectionOrder": ["..."], "entityOrder": {"experience": ["..."], "projects": ["..."], "education": ["..."]}} — no preamble, no commentary. `sectionOrder` and `entityOrder` are optional; omit either if the default order applies.
```

## User template

```
Tailor a resume tagline + section/entity ordering for this posting.

## Posting
- Title: {{postingTitle}}
- Company: {{postingCompany}}
- Seniority: {{postingSeniority}}
- Keywords:
{{postingKeywordsBlock}}

## Profile evidence (the ONLY source of factual claims)
{{profileSummary}}

## Entity IDs (use these exact IDs in entityOrder)
{{entityIdsBlock}}

## Output
{
  "tagline": "<one sentence, ≤ 200 chars, ends with period>",
  "sectionOrder": ["experience", "projects", "education", "skills", "languages", "interests"],
  "entityOrder": {
    "experience": ["<id>", "<id>", ...],
    "projects": ["<id>", "<id>", ...],
    "education": ["<id>", ...]
  }
}
```

## Variables

- `postingTitle` — `posting.title` (string) or `(unknown)`.
- `postingCompany` — `posting.company` (string) or `(unknown)`.
- `postingSeniority` — `posting.seniority` (string) or `(unknown)`.
- `postingKeywordsBlock` — newline-separated list, each line `  - <keyword>`. When `posting.keywords` is empty, the renderer emits `  (none extracted)` instead so the model knows the section was intentionally blank, not missing.
- `profileSummary` — compact profile rendering produced by `buildProfileSummary` from `lib/profile/tagline-draft.ts`. Sections: Identity, Work history, Projects, Education, Skills · Hobbies · Languages. Per-entity cap of ~600 bytes keeps the prompt budget bounded.
- `entityIdsBlock` — a structured listing of each entity's ID + spine label + posting-keyword evidence per section. Used so the model can return `entityOrder` with canonical IDs AND can judge entity strength by evidence rather than name alone. Built from the resume-gen SELECTION (post-scoring), so only entities that survived the bullet-scorer appear here. Format:
  ```
  ### Experience
  - <wr_id>: <Title> @ <Company> [matched: <tag1>, <kw1>, …; aggregate-score=N]
      • <truncated sample bullet 1>
      • <truncated sample bullet 2>
      • (+M more bullets)
  ### Projects
  - <pr_id>: <Project name> [matched: …; aggregate-score=N]
      • <truncated sample bullet>
  ### Education
  - <ed_id>: <Degree> @ <Institution> [matched: …; aggregate-score=N]
      • <truncated sample bullet>
  ```
  Up to 3 sample bullets per entity (chosen highest-score first), each truncated to ~100 chars. Sections with zero selected entities are omitted entirely. Entity name alone (e.g. "Iris") doesn't signal posting-relevance to the LLM — the matched-tag + bullet excerpt does. This is the load-bearing block for the one-page pruner: `getUnremovableEntityIds` spares `selection.{section}[0]`, which equals the LLM's #1 pick after the reorder step. Without evidence in this block, the LLM ranks by name (e.g. "Avionics" sounding more aerospace than "Iris") and the pruner drops higher-evidence entities.

  Fallback (when no selection is supplied, e.g. hermetic smokes): the block degrades to name-only listings of every profile entity. The route always supplies selection, so production runs use the evidence-rich form.

## Notes

- Sibling to `tagline-draft` (the profile dashboard's posting-agnostic draft button). This callsite is invoked at resume-generation time by `app/api/resumes/route.ts` POST and grounds on BOTH profile and posting.
- Server post-processing reuses `postFilterTagline` from `lib/profile/tagline-draft.ts` — same trim / quote-strip / newline-collapse / 200-char hard cap / trailing-period guarantee. Defense-in-depth against rule violations in the LLM output.
- Resume gen swallows AIErrors from this caller and falls back to `profile.tagline` (or no tagline at all). A failed tailor never blocks resume generation.
- See `buildResumeTaglineVars()` in `lib/resumes/tagline-tailor.ts` for the canonical variable assembly. Hermetic smoke `resume-tagline-smoke.ts` covers prompt-render shape + post-filter behavior.
