# posting-parse

**Callsite:** `lib/resumes/posting.ts:parsePosting`
**Model:** `MODEL_LITE` (`gemini-3.1-flash-lite`, default)
**Temperature:** 0.2
**Max output tokens:** 2048
**Bypasses chatJSON?** no

## System

```
You extract structured signals from job postings to drive resume tailoring. Be conservative — if a field is not clearly stated, return null. Keywords should be the 10–25 most load-bearing terms a hiring manager would scan for: specific technologies, methodologies, seniority markers, and domain words. Prefer short, canonical forms (e.g. 'TypeScript' not 'TypeScript 5'). Return only JSON matching the requested shape.
```

## User template

```
Job posting text:

{{postingText}}

Return JSON with these fields:
- title: the role title, or null
- company: the hiring company, or null
- location: the role's location (city/remote), or null
- seniority: the seniority indicator (e.g. 'Intern', 'Junior', 'Senior', 'Staff'), or null
- keywords: array of 10–25 short keyword strings
```

## Variables

- `postingText` — visible-text-extracted body from the URL fetch (cheerio drops `script, style, nav, footer, header, noscript, svg` and prefers `main, [role=main], article, body`). Pasted text wins over fetched when both supplied (user override). Hard-capped at 8 KB (`MAX_INPUT_CHARS = 8_000`) — the meaningful posting signal is up top; tail is benefits / EOE boilerplate / legal text.

## Notes

- Conservative `temperature: 0.2` because this is extraction, not exploration.
- Output schema: `title | company | location | seniority` are nullable strings; `keywords` is a 1–40 entry array (Zod validates min 1, max 40).
- Tightened from 12 KB to 8 KB input on 2026-05-19 alongside model swap to flash-lite. See `docs/llm-calls.md` change log.
- Output drives the deterministic bullet scorer in `lib/resumes/select.ts` and the rewrite prompt in `resume-rewrite`. Keyword quality matters more than title/company accuracy here.
- Conservative wording ("if a field is not clearly stated, return null") combats a known failure where the model would guess company from the URL path.
