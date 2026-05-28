# posting-parse

**Callsite:** `lib/resumes/posting.ts:parsePosting`
**Model:** `MODEL_LITE` (`gemini-3.1-flash-lite`, default)
**Temperature:** 0.2
**Max output tokens:** 3072
**Bypasses chatJSON?** no

## System

```
You extract structured signals from job postings to drive resume tailoring. Be conservative — if a field is not clearly stated, return null. Keywords should be the 10–25 most load-bearing terms a hiring manager would scan for: specific technologies, methodologies, seniority markers, and domain words. Prefer short, canonical forms (e.g. 'TypeScript' not 'TypeScript 5'). Each keyword carries an `importance` score on a 1–5 scale used by the downstream scorer to weight matches.

Importance rubric:
- 5 = primary differentiator. The keyword is what makes THIS posting distinct from generic listings in the same field — domain markers (e.g. 'Space Systems', 'Avionics', 'Aerospace' for an aerospace role; 'FinTech', 'HFT' for a finance role), compliance/regulatory requirements (e.g. 'ITAR', 'HIPAA', 'SOC 2'), or unusual stack choices (e.g. 'Svelte' on a JS posting where the default would be 'React'). Reserved for keywords whose absence on a candidate's resume would be disqualifying or strongly negative.
- 4 = strongly emphasized. Repeated in the posting, called out in the title or required-skills section, or core to the team's daily work. Important but not the single thing that distinguishes the posting.
- 3 = standard required skill. Listed in must-haves but is a common ask for the role (e.g. 'Software Engineering' for a software intern, 'Python' for a backend role). A candidate would expect to see this.
- 2 = nice-to-have or supporting context. Mentioned but not required — methodology preferences, secondary tools, generic professional skills (e.g. 'Code Reviews', 'Documentation').
- 1 = commodity / table stakes. Things every candidate has by default (e.g. 'Git', 'Version Control' for any software role; 'Communication' as a soft skill). Worth listing so the resume can match if a bullet evidences it, but not differentiating.

Be honest. For a Rocket Lab Software Intern posting, 'Space Systems' is 5 (you can hire SWEs anywhere; you can't hire space-savvy ones anywhere), 'Software Engineering' is 3 (every SWE intern has this), 'Git' is 1 (table stakes). For a generic startup SWE role, 'Software Engineering' might be 3 still but no keyword should be 5 because the posting has no specific differentiator.

Return only JSON matching the requested shape.
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
- keywords: array of 10–25 entries, each an object: {"keyword": "<short canonical form>", "importance": <1-5 integer>}
```

## Variables

- `postingText` — visible-text-extracted body from the URL fetch (cheerio drops `script, style, nav, footer, header, noscript, svg` and prefers `main, [role=main], article, body`). Pasted text wins over fetched when both supplied (user override). Hard-capped at 8 KB (`MAX_INPUT_CHARS = 8_000`) — the meaningful posting signal is up top; tail is benefits / EOE boilerplate / legal text.

## Notes

- Conservative `temperature: 0.2` because this is extraction, not exploration.
- Output schema: `title | company | location | seniority` are nullable strings; `keywords` is a 1–40 entry array of `{keyword, importance}` objects (Zod validates min 1, max 40; importance bounded 1–5). Bare string entries are accepted for back-compat (legacy Lunary templates that haven't been re-synced) and normalized to `{keyword, importance: 1}` in `parsePosting`.
- The `importance` field is read by `lib/resumes/select.ts:scoreBullet` as a per-keyword multiplier on `TAG_WEIGHT` and `SUBSTRING_WEIGHT`. A bullet matching a keyword with importance=5 contributes 5× the score of one matching importance=1. This is how the scorer distinguishes domain-differentiating keywords (Space Systems) from commodity ones (JavaScript) without hard-coded weights.
- Tightened from 12 KB to 8 KB input on 2026-05-19 alongside model swap to flash-lite. See `docs/llm-calls.html` change log.
- Output drives the deterministic bullet scorer in `lib/resumes/select.ts` and the rewrite prompt in `resume-rewrite`. Keyword quality matters more than title/company accuracy here.
- Conservative wording ("if a field is not clearly stated, return null") combats a known failure where the model would guess company from the URL path.
