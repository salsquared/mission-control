# resume-rewrite

**Callsite:** `lib/resumes/rewrite.ts:rewriteBullets`
**Model:** `MODEL_FLASH` (`gemini-3.5-flash`) — the only callsite that uses MODEL_FLASH; output ships directly to employers.
**Temperature:** 0.4
**Max output tokens:** 4096
**Bypasses chatJSON?** no

## System

```
You are a resume editor. You rewrite resume bullets so they emphasize what a specific job posting cares about.

Hard rules — never violate:
1. NEVER invent metrics, numbers, percentages, durations, or specific outcomes that aren't already in the original bullet.
2. NEVER claim experience with technologies, methodologies, or domains that aren't already in the original bullet.
3. Preserve the bullet `id` exactly. Returning a bullet with an id that wasn't in the input is a critical failure.
4. Each rewritten bullet stays ~1 line and ≤ 25 words.
5. Lead with a strong action verb (Built, Shipped, Designed, Led, Reduced, Authored, etc.).
6. When the posting uses different terminology for a concept already in the bullet (e.g. 'distributed systems' vs 'microservices'), prefer the posting's wording.
6a. Posting-keyword fold-in. When a bullet's `tags` list contains a posting keyword (i.e. its `matchedTags` array is non-empty), prefer wording that uses those exact keywords verbatim — subject to all other rules (no invention, ≤25 words, strong action verb). If folding the keyword in would force the bullet awkwardly or violate rules 1–2, leave the bullet unchanged; do not force the keyword.
7. If rewriting would require breaking rules 1–2, return the original text unchanged.

Return strictly JSON of shape {"bullets": [{"id", "rewrittenText", "matchedKeywords"}]} — one entry per input bullet, in the same order. `matchedKeywords` lists which of the posting's keywords the rewrite emphasizes.
```

## User template

```
Posting title: {{postingTitle}}
Company: {{postingCompany}}
Seniority: {{postingSeniority}}

Posting keywords (what the posting emphasizes):
{{postingKeywordsBlock}}

{{readmesBlock}}                ← optional, omitted if no project READMEs

Bullets to rewrite (preserve every `id` exactly):
{{bulletsJson}}
```

## Variables

- `postingTitle` — `posting.title` (string) or `(unknown)`.
- `postingCompany` — `posting.company` (string) or `(unknown)`.
- `postingSeniority` — `posting.seniority` (string) or `(unknown)`.
- `postingKeywordsBlock` — newline-separated list, each line `  - <keyword>`. Comes from `posting.keywords.map(k => '  - ' + k).join('\n')`.
- `readmesBlock` — optional. When project-source bullets are in the selection AND `readmeCtx.readmesBySourceId` has entries for them, this expands to:
  ```
  
  Project READMEs (use as factual reference for project-source bullets — do NOT invent new claims, only emphasize what the README confirms is true):
  ### Project README — <projectLabel>
  <readme, sliced to 2KB with "\n…(truncated)" suffix if longer>

  ### Project README — <projectLabel2>
  <...>
  ```
  Each README capped at `PROJECT_README_PROMPT_LIMIT = 2048` bytes; one entry per unique project sourceId (deduped — multiple bullets from the same project don't repeat the README).
- `bulletsJson` — pretty-printed JSON array (2-space indent), one entry per selected bullet:
  ```json
  {
    "id": "blt_xxx",
    "originalText": "...",
    "matchedTags": ["typescript"],
    "matchedKeywords": ["distributed-systems"],
    "sourceLabel": "Acme — Senior Engineer",
    "locked": false
  }
  ```

## Notes

- This is the **only** callsite on MODEL_FLASH (3.5) — output is what the user emails to employers, so quality dominates cost.
- Strict validation: the response's `bullets[].id` must match an id from the input; unknown or duplicate ids throw `AIError`. Missing ids fall back to the original text (logged warn, never silently dropped).
- `matchedKeywords` in the response is metadata for the "Why these bullets?" trace UI — it tells the user which posting keywords each rewrite leaned on. Distinct from the input's `matchedKeywords` (deterministic scorer output).
- The rewriter does NOT regenerate bullet tags — tags stay frozen from the input. (Contrast `bullet-assist-rewrite`, which IS allowed to change tags because the user manually reviews each one.)
- README context is a 2-tier defense against hallucination: rule 2 prohibits invention, README provides additional grounding ("only emphasize what README confirms"). Shipped as part of M9 Phase 2 / Story S9.5.
- See `buildRewriteUserPrompt()` in `lib/resumes/rewrite.ts` for the canonical assembly. Hermetic smoke `readme-prompt-smoke.ts` (13/13) covers the dedup + truncation cases.
