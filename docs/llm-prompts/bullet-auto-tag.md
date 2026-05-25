# bullet-auto-tag

**Callsite:** `lib/profile/auto-tag.ts:autoTagBullets`
**Model:** `MODEL_LITE` (`gemini-3.1-flash-lite`)
**Temperature:** 0.1
**Max output tokens:** 2048
**Bypasses chatJSON?** no

## System

```
You auto-tag the user's resume bullets with posting keywords during a tailored-resume generate. Output only the JSON schema requested — no preamble, no commentary.

Hard rules — never violate:
1. Only add a tag where the bullet's current text already evidences the work that keyword describes. Never invent coverage. When in doubt, omit.
2. Do not propose tags already in the bullet's `tags` array (they're already there).
3. Do not propose tags in the bullet's `removedTags` array (the user explicitly removed these — respect their judgment).
4. Return empty `addedTags` for any bullet you're unsure about. Empty is the safe default; an empty array is always acceptable.
5. Preserve every bullet `id` exactly as given. Returning a bullet with an id that wasn't in the input is a critical failure.
6. Only propose tags drawn from the supplied posting `keywords` list — never invent new strings.
7. Tag matching is conceptual, not literal: a bullet that says "Built a Python API" evidences the keyword "Python"; a bullet that says "Built a Go API" does NOT evidence "Python". The keyword must be a real claim already made by the bullet's wording.
```

## User template

```
Auto-tag the bullets below with any of the posting keywords whose work the bullet's text already evidences. Skip every bullet for which no keyword applies — empty `addedTags` is the safe default.

## Posting keywords (the only allowed tag strings)
{{keywords}}

## Bullets to consider
{{bullets}}

## Output schema
{ "proposals": [ { "bulletId": "<id>", "addedTags": ["<keyword>", ...] }, ... ] }

Only include a proposal entry when `addedTags` is non-empty. Bullets you decide need no new tags MUST be omitted entirely from `proposals` (do not return `{ bulletId, addedTags: [] }`).
```

## Variables

- `keywords` — newline-separated list of posting keywords drawn from `posting.keywords` (output of `posting-parse`). Each line is `  - <keyword>`. The system prompt forbids any tag string not in this list.
- `bullets` — newline-separated flattened bullet list. Each line is
  ```
  - id=<bulletId>; text="<bullet text>"; tags=[<existing tag1>, <existing tag2>]; removedTags=[<blocked tag1>]
  ```
  Excluded bullets (`bullet.excluded === true`) are filtered out by the caller before this list is built — the model never sees them and never proposes for them.

## Notes

- One call per resume generate. Across all of a profile's work-roles / projects / educations.
- Temperature 0.1 — this is binary judgment per (bullet, keyword), not exploration. Conservative wins.
- Output schema is positional-ish: the model returns ONLY the bullets that earned at least one tag. The caller still post-filters each proposal's `addedTags` against `bullet.tags` ∪ `bullet.removedTags` (defense-in-depth — the model occasionally returns already-tagged keywords despite rule 2).
- After post-filter, the caller writes each new tag into both `bullet.tags` (so selection sees it) AND `bullet.autoTags` (so the UI badges it as pending review per Decision 6.3).
- 2048 output tokens is sized for a 30-bullet profile × ~50 tokens per proposal (`{bulletId, addedTags}` is short). Bumps reserved for outlier profiles; failures surface as a `MAX_TOKENS` AIError, not silent truncation.
- The full pipeline is **opt-in by code path**: the auto-tag pass runs only when `lib/resumes/generate.ts` invokes it during a tailored-resume generate. It does not fire on every save or on every email ingest.
